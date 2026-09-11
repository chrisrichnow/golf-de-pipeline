"""Cache ID-matched headshots, tournament and tour logos, and country flags for the dashboard.

Run from the project root after the pipeline has loaded results:
    .venv/Scripts/python.exe scripts/sync_images.py
"""
import concurrent.futures
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re

from dotenv import load_dotenv
import psycopg2
import requests

PROJECT = Path(__file__).resolve().parents[1]
ASSETS = PROJECT / 'dashboard' / 'assets'
HEADSHOT_URLS = ['https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.75,w_160,h_160,q_auto,f_png/headshots_{id}.png',
                 # Face detection fails on a few photos; fall back to a top-anchored crop.
                 'https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_north,w_160,h_160,q_auto,f_png/headshots_{id}.png']
FLAG_URL = 'https://static-assets.pgatour.com/svg-assets/flags/{code}.svg'
LOGO_URLS = ['https://res.cloudinary.com/pgatour-prod/image/upload/e_trim/c_lpad,w_240,h_160,b_white,q_auto,f_png/tournaments/logos/R{id}.png']
ESPN_HEADSHOT_URLS = ['https://a.espncdn.com/combiner/i?img=/i/headshots/golf/players/full/{id}.png&w=160&h=160&scale=crop&cquality=60']
ESPN_FLAG_URL = 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/countries/500/{code}.png&w=40&h=40'
# No current DP World Tour mark is available from these sources; the dashboard shows a text badge.
TOUR_LOGOS = {'liv': 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/leagues/500/livgolf.png&w=240&h=160',
              'ntw': 'https://res.cloudinary.com/pgatour-prod/image/upload/e_trim/c_lpad,w_240,h_160,b_white,q_auto,f_png/tournaments/logos/H000.png',
              'champions-tour': 'https://res.cloudinary.com/pgatour-prod/image/upload/e_trim/c_lpad,w_240,h_160,b_white,q_auto,f_png/tournaments/logos/S000.png'}


def identities():
    load_dotenv(PROJECT / '.env')
    conn = psycopg2.connect(host=os.getenv('GOLF_DB_HOST', 'localhost'), port=os.getenv('GOLF_DB_PORT', '5433'),
                            dbname=os.getenv('GOLF_DB_NAME', 'golf_data'), user=os.getenv('GOLF_DB_USER', 'golf'),
                            password=os.getenv('GOLF_DB_PASSWORD', 'changeme'), connect_timeout=5)
    try:
        with conn, conn.cursor() as cur:
            cur.execute('SELECT DISTINCT player_id, player_name FROM analytics.player_results')
            players = dict(cur.fetchall())
            cur.execute('''SELECT DISTINCT p->>'playerId', concat_ws(' ', p->>'firstName', p->>'lastName')
                           FROM analytics.team_results, jsonb_array_elements(players::jsonb) p''')
            for player_id, name in cur.fetchall():
                if player_id:  # combined-name teams carry no individual IDs
                    players.setdefault(player_id, name)
            cur.execute('''SELECT DISTINCT tournament_id, tournament_name FROM analytics.player_results WHERE org_id = '1'
                           UNION SELECT DISTINCT tournament_id, tournament_name FROM analytics.team_results WHERE org_id = '1' ''')
            tournaments = dict(cur.fetchall())
            cur.execute("SELECT to_regclass('analytics.player_directory') IS NOT NULL")
            flags = {}
            if cur.fetchone()[0]:
                cur.execute('SELECT DISTINCT country_code, country FROM analytics.player_directory '
                            "WHERE player_id = ANY(%s) AND country_code ~ '^[A-Z]{3}$'", (list(players),))
                flags = dict(cur.fetchall())
            cur.execute("SELECT to_regclass('analytics.espn_player_countries') IS NOT NULL")
            if cur.fetchone()[0]:
                cur.execute('SELECT DISTINCT country_code, country FROM analytics.espn_player_countries WHERE country_code IS NOT NULL')
                for code, country in cur.fetchall():
                    flags.setdefault(code, country)
    finally:
        conn.close()
    return players, tournaments, flags


def sync_flags(codes, existing):
    folder = ASSETS / 'flags'
    folder.mkdir(parents=True, exist_ok=True)
    result = {}
    for code, country in codes.items():
        cached = existing.get(code, {})
        if cached.get('status') == 'available' and (ASSETS.parent / cached['path'].lstrip('/')).is_file():
            result[code] = cached
            continue
        record = {'name': country, 'status': 'unavailable'}
        try:
            response = requests.get(FLAG_URL.format(code=code), timeout=20)
            body = response.text
            # Served same-origin, so refuse anything that is not a plain SVG.
            if response.status_code == 200 and body.lstrip().startswith('<svg') and not re.search(r'<script|on\w+=|javascript:', body, re.I):
                (folder / f'{code}.svg').write_text(body, encoding='utf-8')
                record.update(status='available', path=f'/assets/flags/{code}.svg')
        except requests.RequestException:
            pass
        if record['status'] != 'available':
            try:
                response = requests.get(ESPN_FLAG_URL.format(code=code.lower()), headers=BROWSER, timeout=20)
                if response.status_code == 200 and response.headers.get('content-type', '').startswith('image/png'):
                    (folder / f'{code}.png').write_bytes(response.content)
                    record.update(status='available', path=f'/assets/flags/{code}.png')
            except requests.RequestException:
                pass
        result[code] = record
    return result


BROWSER = {'User-Agent': 'Mozilla/5.0 (golf-de-pipeline; personal portfolio project)'}


def sync(kind, items, url_templates, existing):
    folder = ASSETS / kind
    folder.mkdir(parents=True, exist_ok=True)

    def fetch(item):
        item_id, name = item
        path = folder / f'{item_id}.png'
        if existing.get(item_id, {}).get('status') == 'available' and path.is_file():
            return item_id, existing[item_id]
        record = {'name': name, 'status': 'unavailable'}
        templates = url_templates(item_id) if callable(url_templates) else url_templates
        for template in templates:
            url = template.format(id=str(item_id).removeprefix('espn-'))
            try:
                response = requests.get(url, headers=BROWSER, timeout=20)
            except requests.RequestException:
                continue
            if response.status_code == 200 and response.headers.get('content-type', '').startswith('image/png'):
                path.write_bytes(response.content)
                record.update(status='available', path=f'/assets/{kind}/{item_id}.png', source_url=url)
                break
        return item_id, record

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        return dict(pool.map(fetch, items.items()))


def main():
    players, tournaments, flags = identities()
    manifest_path = ASSETS / 'images.json'
    existing = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    payload = {
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
        'source': 'PGA TOUR image CDN, matched by official player and tournament IDs',
        'players': sync('headshots', players, lambda pid: ESPN_HEADSHOT_URLS if pid.startswith('espn-') else HEADSHOT_URLS, existing.get('players', {})),
        'tournaments': sync('logos', tournaments, LOGO_URLS, existing.get('tournaments', {})),
        'flags': sync_flags(flags, existing.get('flags', {})),
        'tours': sync('logos', {f'tour-{slug}': slug for slug in TOUR_LOGOS}, lambda key: [TOUR_LOGOS[key.removeprefix('tour-')]], existing.get('tours', {})),
    }
    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    for kind in ('players', 'tournaments', 'flags', 'tours'):
        records = payload[kind].values()
        missing = [r['name'] for r in records if r['status'] != 'available']
        print(f"{kind}: {len(records) - len(missing)}/{len(records)} cached" + (f" · missing {len(missing)}" if missing else ''))


if __name__ == '__main__':
    main()
