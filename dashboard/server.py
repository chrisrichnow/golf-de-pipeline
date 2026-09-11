"""Local, read-only golf dashboard. Run: python dashboard/server.py"""
import argparse
import gzip
from datetime import date, datetime, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / '.env')
CACHE = {'signature': None, 'plain': None, 'gzip': None}
TOURS = {'1': 'PGA TOUR', 'eur': 'DP World Tour', 'liv': 'LIV Golf', 'ntw': 'Korn Ferry Tour', 'champions-tour': 'PGA TOUR Champions'}


def connect():
    return psycopg2.connect(
        host=os.getenv('GOLF_DB_HOST', 'localhost'),
        port=os.getenv('GOLF_DB_PORT', '5433'),
        dbname=os.getenv('GOLF_DB_NAME', 'golf_data'),
        user=os.getenv('GOLF_DB_USER', 'golf'),
        password=os.getenv('GOLF_DB_PASSWORD', 'changeme'),
        connect_timeout=5,
        options='-c statement_timeout=10000',
    )


def signature():
    # Cheap fingerprint of the analytics tables; the transform rewrites them atomically.
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute('''SELECT (SELECT count(*) FROM analytics.player_results), (SELECT max(ingested_at) FROM analytics.player_results),
                (SELECT count(*) FROM analytics.team_results), (SELECT max(fetched_at) FROM raw.slash_golf_schedules),
                (SELECT max(ingested_at) FROM raw.pga_tour_player_directory)''')
            return cur.fetchone()
    finally:
        conn.close()


def payload():
    current = signature()
    if CACHE['signature'] != current:
        body = json.dumps(read_data(), default=serialize, separators=(',', ':')).encode('utf-8')
        CACHE.update(signature=current, plain=body, gzip=gzip.compress(body, 5))
    return CACHE


def read_data():
    conn = connect()
    try:
        conn.set_session(readonly=True, isolation_level='REPEATABLE READ')
        with conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute('''SELECT org_id, season_year, tournament_id, tournament_name,
                    event_end_date, player_id, player_name, finish_position, finish_rank,
                    score_text, score_to_par, player_status, rounds_played
                    FROM analytics.player_results
                    ORDER BY event_end_date, tournament_id, finish_rank NULLS LAST, player_name''')
                players = cur.fetchall()
                cur.execute('''SELECT org_id, season_year, tournament_id, tournament_name,
                    event_end_date, team_id, players, finish_position, score_text, score_to_par
                    FROM analytics.team_results ORDER BY event_end_date, tournament_id, team_id''')
                teams = cur.fetchall()
                cur.execute('SELECT * FROM analytics.player_season_summary ORDER BY wins DESC, top_10s DESC, player_name')
                summaries = cur.fetchall()
                cur.execute('''SELECT org_id, season_year, max(fetched_at) AS schedule_checked_at
                    FROM raw.slash_golf_schedules GROUP BY org_id, season_year''')
                freshness = cur.fetchall()
                countries = {}
                cur.execute("SELECT to_regclass('analytics.player_directory') IS NOT NULL AS ready")
                if cur.fetchone()['ready']:
                    cur.execute('SELECT player_id, country, country_code FROM analytics.player_directory WHERE country IS NOT NULL')
                    countries = {r['player_id']: {'country': r['country'], 'code': r['country_code']} for r in cur.fetchall()}
                cur.execute("SELECT to_regclass('analytics.espn_player_countries') IS NOT NULL AS ready")
                if cur.fetchone()['ready']:
                    cur.execute('SELECT player_id, country, country_code FROM analytics.espn_player_countries')
                    countries.update({r['player_id']: {'country': r['country'], 'code': r['country_code']} for r in cur.fetchall()})
        return {'players': players, 'teams': teams, 'summaries': summaries, 'countries': countries, 'tours': TOURS,
                'freshness': freshness, 'retrieved_at': datetime.now(timezone.utc)}
    finally:
        conn.close()


def serialize(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f'Unsupported JSON type: {type(value).__name__}')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        files = {'/': ('index.html', 'text/html; charset=utf-8'),
                 '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                 '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
                 '/favicon.svg': ('favicon.svg', 'image/svg+xml'),
                 '/pga-tour-logo.svg': ('pga-tour-logo.svg', 'image/svg+xml')}
        if path == '/api/data':
            try:
                cached = payload()
                # ~70k result rows across five tours; gzip cuts the transfer roughly tenfold.
                if 'gzip' in self.headers.get('Accept-Encoding', ''):
                    self.respond(200, cached['gzip'], 'application/json', encoding='gzip')
                else:
                    self.respond(200, cached['plain'], 'application/json')
            except psycopg2.Error:
                self.respond(503, json.dumps({'error': 'The golf database is unavailable or analytics are not ready. Start Postgres and run pipeline.py --transform-only, then retry.'}).encode(), 'application/json')
            return
        if path == '/assets/images.json':
            manifest = ROOT / 'assets' / 'images.json'
            self.respond(200, manifest.read_bytes() if manifest.is_file() else b'{}', 'application/json')
            return
        if re.fullmatch(r'/assets/(headshots/(espn-)?\d+|logos/(\d+|tour-[a-z-]+)|flags/[A-Z]{2,3})\.png', path) and (ROOT / path.lstrip('/')).is_file():
            self.respond(200, (ROOT / path.lstrip('/')).read_bytes(), 'image/png', 'public, max-age=86400')
            return
        if re.fullmatch(r'/assets/flags/[A-Z]{2,3}\.svg', path) and (ROOT / path.lstrip('/')).is_file():
            self.respond(200, (ROOT / path.lstrip('/')).read_bytes(), 'image/svg+xml', 'public, max-age=86400')
            return
        if path in files:
            name, content_type = files[path]
            self.respond(200, (ROOT / name).read_bytes(), content_type)
        else:
            self.respond(404, b'Not found', 'text/plain')

    def respond(self, status, body, content_type, cache='no-store', encoding=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8050)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'PGA Analytics: http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
