"""Backfill final leaderboards for non-PGA tours from ESPN's public golf data.

ESPN is not a documented API. Each event is validated and saved with its checkpoint in one
transaction, so an interrupted run resumes where it stopped. Run from the project root:
    .venv/Scripts/python.exe -m ingestion.ingest_espn_tours --seasons 2023 2024 2025 2026
"""
import argparse
import time

from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import Json
import requests

from config.logging_config import get_logger
from ingestion.backfill_slash_golf import connect
from ingestion.ingest_slash_golf import PROJECT_ROOT

log = get_logger('ingest_espn_tours')
TOURS = {'eur': 'DP World Tour', 'liv': 'LIV Golf', 'ntw': 'Korn Ferry Tour', 'champions-tour': 'PGA TOUR Champions'}
EVENTS_URL = 'https://sports.core.api.espn.com/v2/sports/golf/leagues/{league}/seasons/{season}/types/2/events?limit=200'
LEADERBOARD_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league={league}&event={event}'


class Client:
    def __init__(self, pause=0.4):
        self.session = requests.Session()
        self.session.headers['User-Agent'] = 'Mozilla/5.0 (golf-de-pipeline; personal portfolio project)'
        self.pause, self.calls = pause, 0

    def get(self, url):
        if self.calls:
            time.sleep(self.pause)
        self.calls += 1
        response = self.session.get(url, timeout=30)
        if response.status_code in (403, 429):
            raise RuntimeError(f'ESPN returned HTTP {response.status_code}; stopping to avoid being blocked.')
        response.raise_for_status()
        return response.json()


def event_ids(client, league, season):
    items = client.get(EVENTS_URL.format(league=league, season=season)).get('items', [])
    return [item['$ref'].split('/events/')[1].split('?')[0] for item in items]


def validate(data, event_id):
    """Return (event, competitors) for a final individual leaderboard, else raise/defer."""
    events = data.get('events') or []
    event = next((e for e in events if str(e.get('id')) == event_id), None)
    if event is None:
        raise ValueError('Leaderboard response does not contain the requested event.')
    if event.get('status', {}).get('type', {}).get('name') != 'STATUS_FINAL':
        return event, None
    competitions = event.get('competitions') or []
    if len(competitions) != 1 or not isinstance(competitions[0], dict):
        raise ValueError('Event is not a single stroke-play leaderboard (team or match-play format).')
    competitors = competitions[0].get('competitors') or []
    if not competitors:
        raise ValueError('Event has no individual leaderboard (team or match-play format).')
    if not all(isinstance(c, dict) and c.get('athlete', {}).get('id') for c in competitors):
        raise ValueError('A competitor is missing an athlete ID (team format).')
    return event, competitors


def checkpoint(cur, league, season, event_id, name, status, raw_id=None, count=0, error=None):
    cur.execute('''INSERT INTO ops.espn_golf_backfill (league, season_year, event_id, event_name, status, raw_id, row_count, error)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (league, season_year, event_id) DO UPDATE SET
        event_name=EXCLUDED.event_name, status=EXCLUDED.status, raw_id=EXCLUDED.raw_id,
        row_count=EXCLUDED.row_count, error=EXCLUDED.error, updated_at=now()''',
                (league, season, event_id, name, status, raw_id, count, error))


def run(leagues, seasons, retry_failed=False, limit=None):
    load_dotenv(PROJECT_ROOT / '.env')
    client = Client()
    conn = connect()
    totals = {'complete': 0, 'deferred': 0, 'failed': 0}
    try:
        with conn, conn.cursor() as cur:
            cur.execute('SELECT pg_try_advisory_lock(20260910, 2)')
            if not cur.fetchone()[0]:
                raise RuntimeError('Another ESPN backfill is already running.')
            cur.execute((PROJECT_ROOT / 'sql/create_espn_tables.sql').read_text(encoding='utf-8'))
        for league in leagues:
            for season in seasons:
                with conn, conn.cursor() as cur:
                    skip = ('complete',) if retry_failed else ('complete', 'failed')
                    cur.execute('SELECT event_id FROM ops.espn_golf_backfill WHERE league=%s AND season_year=%s AND status = ANY(%s)',
                                (league, season, list(skip)))
                    done = {row[0] for row in cur.fetchall()}
                pending = [e for e in event_ids(client, league, season) if e not in done]
                if limit is not None:
                    pending = pending[:limit]
                log.info('%s %s: %d pending events', TOURS[league], season, len(pending))
                for event_id in pending:
                    try:
                        data = client.get(LEADERBOARD_URL.format(league=league, event=event_id))
                        event, competitors = validate(data, event_id)
                        with conn, conn.cursor() as cur:
                            if competitors is None:
                                checkpoint(cur, league, season, event_id, event.get('name'), 'deferred', error='Not final yet.')
                                totals['deferred'] += 1
                                continue
                            cur.execute('''INSERT INTO raw.espn_golf_leaderboards (league, season_year, event_id, payload)
                                VALUES (%s,%s,%s,%s) RETURNING id''', (league, season, event_id, Json(event)))
                            raw_id = cur.fetchone()[0]
                            checkpoint(cur, league, season, event_id, event.get('name'), 'complete', raw_id, len(competitors))
                        totals['complete'] += 1
                    except (ValueError, requests.RequestException, psycopg2.Error) as error:
                        conn.rollback()
                        message = str(error)[:500]
                        with conn, conn.cursor() as cur:
                            checkpoint(cur, league, season, event_id, None, 'failed', error=message)
                        totals['failed'] += 1
                        log.warning('Failed %s %s %s: %s', league, season, event_id, message)
    finally:
        conn.close()
    log.info('ESPN backfill finished: %s; %d requests', totals, client.calls)
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--leagues', nargs='+', default=list(TOURS), choices=list(TOURS))
    parser.add_argument('--seasons', nargs='+', default=['2026'])
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--limit', type=int, help='Maximum pending events per tour-season (for testing).')
    args = parser.parse_args()
    run(args.leagues, args.seasons, args.retry_failed, args.limit)


if __name__ == '__main__':
    main()
