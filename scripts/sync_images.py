"""Cache ID-matched PGA TOUR player headshots and tournament logos for the dashboard.

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
                players.setdefault(player_id, name)
            cur.execute('''SELECT DISTINCT tournament_id, tournament_name FROM analytics.player_results
                           UNION SELECT DISTINCT tournament_id, tournament_name FROM analytics.team_results''')
            tournaments = dict(cur.fetchall())
            cur.execute("SELECT to_regclass('analytics.player_directory') IS NOT NULL")
            flags = {}
            if cur.fetchone()[0]:
                cur.execute('SELECT DISTINCT country_code, country FROM analytics.player_directory '
                            "WHERE player_id = ANY(%s) AND country_code ~ '^[A-Z]{3}$'", (list(players),))
                flags = dict(cur.fetchall())
    finally:
        conn.close()
    return players, tournaments, flags


def sync_flags(codes, existing):
    folder = ASSETS / 'flags'
    folder.mkdir(parents=True, exist_ok=True)
    result = {}
    for code, country in codes.items():
        path = folder / f'{code}.svg'
        if existing.get(code, {}).get('status') == 'available' and path.is_file():
            result[code] = existing[code]
            continue
        record = {'name': country, 'status': 'unavailable'}
        try:
            response = requests.get(FLAG_URL.format(code=code), timeout=20)
            body = response.text
            # Served same-origin, so refuse anything that is not a plain SVG.
            if response.status_code == 200 and body.lstrip().startswith('<svg') and not re.search(r'<script|on\w+=|javascript:', body, re.I):
                path.write_text(body, encoding='utf-8')
                record.update(status='available', path=f'/assets/flags/{code}.svg')
        except requests.RequestException:
            pass
        result[code] = record
    return result


def sync(kind, items, url_templates, existing):
    folder = ASSETS / kind
    folder.mkdir(parents=True, exist_ok=True)

    def fetch(item):
        item_id, name = item
        path = folder / f'{item_id}.png'
        if existing.get(item_id, {}).get('status') == 'available' and path.is_file():
            return item_id, existing[item_id]
        record = {'name': name, 'status': 'unavailable'}
        for template in url_templates:
            url = template.format(id=item_id)
            try:
                response = requests.get(url, timeout=20)
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
        'players': sync('headshots', players, HEADSHOT_URLS, existing.get('players', {})),
        'tournaments': sync('logos', tournaments, LOGO_URLS, existing.get('tournaments', {})),
        'flags': sync_flags(flags, existing.get('flags', {})),
    }
    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    for kind in ('players', 'tournaments', 'flags'):
        records = payload[kind].values()
        missing = [r['name'] for r in records if r['status'] != 'available']
        print(f"{kind}: {len(records) - len(missing)}/{len(records)} cached" + (f" · missing: {', '.join(missing)}" if missing else ''))


if __name__ == '__main__':
    main()
