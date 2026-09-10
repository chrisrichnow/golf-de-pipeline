"""Run the local golf pipeline, or rebuild analytics without API requests."""
import argparse
from datetime import date

from dotenv import load_dotenv

from ingestion.backfill_slash_golf import connect, run as backfill
from ingestion.ingest_pga_tour_players import run as ingest_player_directory
from ingestion.ingest_slash_golf import PROJECT_ROOT
from config.logging_config import get_logger

log = get_logger('pipeline')


def setup_database():
    load_dotenv(PROJECT_ROOT / '.env')
    conn = connect()
    try:
        with conn:
            with conn.cursor() as cur:
                for name in ('create_staging_tables.sql', 'create_backfill_tables.sql'):
                    cur.execute((PROJECT_ROOT / 'sql' / name).read_text(encoding='utf-8-sig'))
    finally:
        conn.close()


def check_quality(cur):
    cur.execute((PROJECT_ROOT / 'sql/quality_checks.sql').read_text(encoding='utf-8-sig'))
    checks = dict(cur.fetchall())
    failures = {name: count for name, count in checks.items() if count}
    if failures:
        raise ValueError(f'Data quality checks failed: {failures}')
    return checks


def transform():
    load_dotenv(PROJECT_ROOT / '.env')
    conn = connect()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                cur.execute('SELECT pg_advisory_xact_lock(20260909, 1)')
                cur.execute((PROJECT_ROOT / 'sql/transform.sql').read_text(encoding='utf-8-sig'))
                checks = check_quality(cur)
                cur.execute('SELECT count(*) FROM analytics.player_results')
                players = cur.fetchone()[0]
                cur.execute('SELECT count(*) FROM analytics.team_results')
                teams = cur.fetchone()[0]
        log.info('Analytics committed: %d players, %d teams; %d quality checks passed',
                 players, teams, len(checks))
        return {'players': players, 'teams': teams, 'quality_checks': checks}
    finally:
        conn.close()


def ingest(year=2026, as_of=None, max_requests=10, refresh_schedule=False):
    setup_database()
    result = backfill(argparse.Namespace(
        year=year, as_of=as_of or date.today(), max_requests=max_requests,
        refresh_schedule=refresh_schedule, limit=None,
    ))
    if result:
        raise RuntimeError('Ingestion has failed or deferred events; inspect ingestion logs.')
    refresh_player_directory()


def refresh_player_directory():
    # Country is enrichment; a changed or unreachable page must not block results ingestion.
    try:
        ingest_player_directory()
    except Exception as error:
        log.warning('PGA TOUR player directory refresh skipped: %s', error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--transform-only', action='store_true', help='Use saved data; no API calls.')
    parser.add_argument('--year', type=int, default=2026)
    parser.add_argument('--as-of', type=date.fromisoformat, default=date.today())
    parser.add_argument('--max-requests', type=int, default=10)
    parser.add_argument('--refresh-schedule', action='store_true')
    parser.add_argument('--refresh-players', action='store_true',
                        help='With --transform-only: refresh the PGA TOUR player directory (no Slash Golf calls).')
    args = parser.parse_args()
    if args.max_requests < 1:
        parser.error('--max-requests must be positive')
    if args.transform_only:
        setup_database()
        if args.refresh_players:
            refresh_player_directory()
    else:
        ingest(args.year, args.as_of, args.max_requests, args.refresh_schedule)
    transform()


if __name__ == '__main__':
    main()
