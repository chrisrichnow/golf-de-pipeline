"""Land the PGA TOUR player directory (IDs, names, country) into raw.pga_tour_player_directory.

The directory is embedded as JSON in the public pgatour.com/players page. It is not a
documented API, so parsing fails loudly if the page shape changes. One run = one snapshot.
"""
import json
import re
import uuid

from dotenv import load_dotenv
import requests

from config.logging_config import get_logger
from ingestion.backfill_slash_golf import connect
from ingestion.ingest_slash_golf import PROJECT_ROOT

log = get_logger('ingest_pga_tour_players')
DIRECTORY_URL = 'https://www.pgatour.com/players'


def parse_directory(html):
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        raise ValueError('PGA TOUR players page has no embedded data; the page layout may have changed.')
    queries = json.loads(match.group(1))['props']['pageProps']['dehydratedState']['queries']
    for query in queries:
        key = query.get('queryKey')
        if isinstance(key, list) and key and key[0] == 'playerDirectory':
            players = query['state']['data']['players']
            if not players or not all(p.get('id') for p in players):
                raise ValueError('PGA TOUR player directory is empty or missing player IDs.')
            return players
    raise ValueError('PGA TOUR player directory not found in page data.')


def run():
    load_dotenv(PROJECT_ROOT / '.env')
    response = requests.get(DIRECTORY_URL, headers={'User-Agent': 'Mozilla/5.0'}, timeout=30)
    response.raise_for_status()
    players = parse_directory(response.text)
    run_id = uuid.uuid4()
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.executemany('INSERT INTO raw.pga_tour_player_directory (source_run_id, payload) VALUES (%s, %s)',
                            [(str(run_id), json.dumps(p)) for p in players])
    finally:
        conn.close()
    log.info('Landed %d PGA TOUR directory players (run %s)', len(players), run_id)
    return len(players)


if __name__ == '__main__':
    run()
