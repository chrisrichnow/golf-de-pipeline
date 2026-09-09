"""Manually backfill completed events, resuming at tournament checkpoints."""
import argparse
from datetime import date, datetime, timezone
import os
import time
import uuid

import psycopg2
from psycopg2.extras import Json
import requests
from dotenv import load_dotenv

from ingestion.ingest_slash_golf import PROJECT_ROOT, prepare_records, log


class StopBackfill(RuntimeError):
    pass


class API:
    def __init__(self, max_requests):
        key = os.getenv('SLASH_GOLF_API_KEY', '').strip()
        if not key:
            raise ValueError('Set SLASH_GOLF_API_KEY in .env.')
        self.headers = {'x-rapidapi-key': key, 'x-rapidapi-host': 'live-golf-data.p.rapidapi.com'}
        self.max_requests = max_requests
        self.calls = 0
        self.remaining = None

    def get(self, endpoint, params):
        if self.calls >= self.max_requests or (self.remaining is not None and self.remaining <= 1):
            raise StopBackfill('Request budget exhausted; rerun after checking RapidAPI usage.')
        if self.calls:
            time.sleep(1)
        self.calls += 1
        try:
            response = requests.get(
                'https://live-golf-data.p.rapidapi.com/' + endpoint,
                headers=self.headers, params=params, timeout=30,
            )
        except requests.RequestException:
            raise ValueError('API connection failed; no automatic retry.') from None
        remaining = response.headers.get('x-ratelimit-requests-remaining')
        if remaining is not None and remaining.isdigit():
            self.remaining = int(remaining)
        if response.status_code in (401, 403, 429):
            raise StopBackfill(f'HTTP {response.status_code}: check API access or quota before resuming.')
        if response.status_code != 200:
            raise ValueError(f'API returned HTTP {response.status_code}.')
        try:
            return response.json()
        except ValueError:
            raise ValueError('API returned invalid JSON.') from None


def connect():
    return psycopg2.connect(
        host=os.getenv('GOLF_DB_HOST', 'localhost'), port=os.getenv('GOLF_DB_PORT', '5433'),
        dbname=os.getenv('GOLF_DB_NAME', 'golf_data'), user=os.getenv('GOLF_DB_USER', 'golf'),
        password=os.getenv('GOLF_DB_PASSWORD', 'changeme'), connect_timeout=5,
    )


def schedule(conn, api, year, refresh):
    with conn:
        with conn.cursor() as cur:
            cur.execute('SELECT payload FROM raw.slash_golf_schedules WHERE org_id=%s AND season_year=%s', ('1', year))
            cached = cur.fetchone()
    if cached and not refresh:
        data = cached[0]
    else:
        data = api.get('schedule', {'orgId': '1', 'year': year})
    if not isinstance(data, dict) or str(data.get('year')) != year or not isinstance(data.get('schedule'), list):
        raise ValueError('Schedule does not match the requested year or expected structure.')
    if str(data.get('orgId', '1')) != '1':
        raise ValueError('Schedule belongs to a different tour.')
    if not cached or refresh:
        with conn:
            with conn.cursor() as cur:
                cur.execute('''INSERT INTO raw.slash_golf_schedules (org_id, season_year, payload)
                    VALUES (%s,%s,%s) ON CONFLICT (org_id,season_year)
                    DO UPDATE SET payload=EXCLUDED.payload, fetched_at=now()''', ('1', year, Json(data)))
    return data['schedule']


def event_end_date(event):
    value = event['date']['end']
    if isinstance(value, dict):
        value = value['$date']
        if isinstance(value, dict):
            value = int(value['$numberLong'])
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date()
    return date.fromisoformat(value[:10])


def candidates(events, as_of):
    result = []
    seen = set()
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get('tournId'), str) or not event['tournId']:
            raise ValueError('Schedule contains an invalid tournament ID.')
        try:
            end_date = event_end_date(event)
        except (KeyError, TypeError, ValueError, OverflowError, OSError):
            raise ValueError('Schedule contains an invalid event end date.') from None
        if event['tournId'] in seen:
            raise ValueError('Schedule contains duplicate tournament IDs.')
        seen.add(event['tournId'])
        if end_date < as_of:
            result.append(event)
    return sorted(result, key=lambda e: (event_end_date(e), e['tournId']))


def checkpoint(cur, year, event, status, run_id=None, count=0, error=None):
    cur.execute('''INSERT INTO ops.slash_golf_backfill
        (org_id,season_year,tournament_id,tournament_name,status,source_run_id,row_count,error)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (org_id,season_year,tournament_id) DO UPDATE SET
        tournament_name=EXCLUDED.tournament_name,status=EXCLUDED.status,
        source_run_id=EXCLUDED.source_run_id,row_count=EXCLUDED.row_count,
        error=EXCLUDED.error,updated_at=now()''',
        ('1', year, event['tournId'], event.get('name', event['tournId']), status, run_id, count, error))


def save_event(conn, year, event, records):
    run_id = str(uuid.uuid4())
    with conn:
        with conn.cursor() as cur:
            cur.executemany('INSERT INTO raw.slash_golf_results (source_run_id,payload) VALUES (%s,%s)',
                            [(run_id, Json(record)) for record in records])
            cur.execute('SELECT count(*) FROM raw.slash_golf_results WHERE source_run_id=%s', (run_id,))
            if cur.fetchone()[0] != len(records):
                raise ValueError('Inserted row count mismatch.')
            checkpoint(cur, year, event, 'complete', run_id, len(records))
    return run_id


def run(args):
    load_dotenv(PROJECT_ROOT / '.env')
    api = API(args.max_requests)
    conn = connect()
    try:
        # Session lock prevents two backfills from spending requests/loading the same event.
        with conn:
            with conn.cursor() as cur:
                cur.execute('SELECT pg_try_advisory_lock(20260907, 1)')
                if not cur.fetchone()[0]:
                    raise StopBackfill('Another backfill is already running.')
                cur.execute((PROJECT_ROOT / 'sql/create_backfill_tables.sql').read_text(encoding='utf-8'))
        events = schedule(conn, api, str(args.year), args.refresh_schedule)
        eligible = candidates(events, args.as_of)
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT tournament_id FROM ops.slash_golf_backfill WHERE org_id='1' AND season_year=%s AND status='complete'", (str(args.year),))
                done = {row[0] for row in cur.fetchall()}
        pending = [event for event in eligible if event['tournId'] not in done]
        log.info('Schedule: %d events; %d ended before %s; %d pending; %d already complete',
                 len(events), len(eligible), args.as_of, len(pending), len(eligible)-len(pending))
        if args.limit is not None:
            pending = pending[:args.limit]
        completed = failed = deferred = 0
        for event in pending:
            params = {'orgId': '1', 'year': str(args.year), 'tournId': event['tournId']}
            try:
                # Omitting optional roundId requests the latest leaderboard.
                data = api.get('leaderboard', params)
                records = prepare_records(data, params, allow_teams=event.get('format') == 'team')
                if str(data.get('status', '')).lower() != 'official':
                    with conn:
                        with conn.cursor() as cur:
                            checkpoint(cur, str(args.year), event, 'deferred', error='Leaderboard not Official yet.')
                    deferred += 1
                    log.info('Deferred %s: leaderboard not Official', event['tournId'])
                    continue
                for record in records:
                    record['schedule'] = event
                save_event(conn, str(args.year), event, records)
                completed += 1
                log.info('Loaded %s %s: %d records', event['tournId'], event.get('name', ''), len(records))
            except (ValueError, psycopg2.Error) as error:
                conn.rollback()
                message = str(error) if isinstance(error, ValueError) else 'Database write failed; event rolled back.'
                with conn:
                    with conn.cursor() as cur:
                        checkpoint(cur, str(args.year), event, 'failed', error=message)
                failed += 1
                log.error('Failed %s: %s', event['tournId'], message)
        log.info('Finished: %d loaded, %d failed, %d deferred; %d API requests this execution; reported quota remaining=%s',
                 completed, failed, deferred, api.calls, api.remaining)
        return 1 if failed or deferred else 0
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--year', type=int, default=2026)
    parser.add_argument('--as-of', type=date.fromisoformat, default=date.today())
    parser.add_argument('--limit', type=int, help='Maximum number of pending events to attempt.')
    parser.add_argument('--max-requests', type=int, default=60, help='Per-execution cap, not monthly usage.')
    parser.add_argument('--refresh-schedule', action='store_true')
    args = parser.parse_args()
    if args.max_requests < 1 or (args.limit is not None and args.limit < 1):
        parser.error('Request cap and limit must be positive.')
    try:
        return run(args)
    except (StopBackfill, ValueError) as error:
        log.error('%s', error)
        return 1
    except psycopg2.Error:
        log.error('Database operation failed. Check Docker and .env; completed events remain saved.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
