"""Fetch one leaderboard and append a raw snapshot, one row per player.

Re-running creates another snapshot with a new run ID, without overwriting old data.
"""
import os
import sys
import uuid
from pathlib import Path

import psycopg2
from psycopg2.extras import Json
import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
from config.logging_config import get_logger

log = get_logger('ingest_slash_golf')


def prepare_records(data, expected, *, allow_teams=False):
    """Preserve each source entry as a player or explicitly identified team."""
    if not isinstance(data, dict):
        raise ValueError('Expected a JSON object from the API.')
    for field, value in expected.items():
        actual = data.get(field)
        # The live API may encode roundId using MongoDB Extended JSON.
        # Unwrap only for validation; keep the original payload unchanged.
        if field == 'roundId' and isinstance(actual, dict):
            actual = actual.get('$numberInt')
        if str(actual) != str(value):
            raise ValueError(f'API response does not match requested {field}.')
    players = data.get('leaderboardRows')
    if not isinstance(players, list) or not players:
        raise ValueError('API response has no player records to load.')
    context = {k: v for k, v in data.items() if k != 'leaderboardRows'}
    records = []
    for entry in players:
        if not isinstance(entry, dict):
            raise ValueError('A leaderboard entry is not an object.')
        if entry.get('playerId'):
            records.append({'tournament': context, 'player': entry})
        elif (allow_teams and entry.get('teamId') and isinstance(entry.get('players'), list)
              and entry['players'] and all(isinstance(p, dict) and p.get('playerId') for p in entry['players'])):
            records.append({'tournament': context, 'team': entry})
        else:
            raise ValueError('A leaderboard entry is missing a valid player or supported team identity.')
    return records


def fetch_results():
    api_key = os.getenv('SLASH_GOLF_API_KEY', '').strip()
    if not api_key:
        raise ValueError('Set SLASH_GOLF_API_KEY in the project .env file.')
    params = {'orgId': '1', 'year': '2024', 'tournId': '020', 'roundId': '4'}
    response = requests.get(
        'https://live-golf-data.p.rapidapi.com/leaderboard',
        headers={'x-rapidapi-key': api_key, 'x-rapidapi-host': 'live-golf-data.p.rapidapi.com'},
        params=params,
        timeout=30,
    )
    if response.status_code != 200:
        raise ValueError(f'API returned HTTP {response.status_code}; check access and quota in RapidAPI.')
    try:
        data = response.json()
    except ValueError:
        raise ValueError('API response was not valid JSON.') from None
    return prepare_records(data, params)


def load_raw(connection, records):
    run_id = str(uuid.uuid4())
    # One transaction: all player rows commit together, or all roll back.
    with connection:
        with connection.cursor() as cursor:
            cursor.executemany(
                'INSERT INTO raw.slash_golf_results (source_run_id, payload) VALUES (%s, %s)',
                [(run_id, Json(record)) for record in records],
            )
            cursor.execute(
                'SELECT count(*) FROM raw.slash_golf_results WHERE source_run_id = %s', (run_id,)
            )
            count = cursor.fetchone()[0]
            if count != len(records):
                raise ValueError('Inserted count did not match fetched records.')
    return run_id, count


def main():
    load_dotenv(PROJECT_ROOT / '.env')
    connection = None
    try:
        connection = psycopg2.connect(
            host=os.getenv('GOLF_DB_HOST', 'localhost'),
            port=os.getenv('GOLF_DB_PORT', '5433'),
            dbname=os.getenv('GOLF_DB_NAME', 'golf_data'),
            user=os.getenv('GOLF_DB_USER', 'golf'),
            password=os.getenv('GOLF_DB_PASSWORD', 'changeme'),
            connect_timeout=5,
        )
        # Check the destination before spending an API request.
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT to_regclass('raw.slash_golf_results')")
                if cursor.fetchone()[0] is None:
                    raise ValueError('Run sql/create_staging_tables.sql first.')
        log.info('Fetching 2024 Houston Open, round 4')
        records = fetch_results()
        run_id, count = load_raw(connection, records)
        log.info('Committed and verified %d rows in raw.slash_golf_results; run_id=%s', count, run_id)
    except requests.RequestException:
        raise SystemExit('API connection failed. No records were loaded.') from None
    except psycopg2.Error:
        raise SystemExit('Database operation failed. Check Docker and .env; this run was not completed.') from None
    except ValueError as error:
        raise SystemExit(str(error)) from None
    finally:
        if connection is not None:
            connection.close()


if __name__ == '__main__':
    main()
