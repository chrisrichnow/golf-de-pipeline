"""Pulls player skill ratings/rankings from the Data Golf API and lands them raw
into raw.data_golf_rankings. No transformation here — see sql/transform.sql.

TODO once API key is in hand: confirm base URL, auth param format (Data Golf
typically uses a query-string key rather than a header — verify), and the actual
endpoint(s) for skill ratings/rankings — the values below are placeholders.
"""

import os
import uuid

import psycopg2
import psycopg2.extras
import requests
from dotenv import load_dotenv

import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parent.parent))
from config.logging_config import get_logger

load_dotenv()
log = get_logger("ingest_data_golf")

API_KEY = os.environ["DATA_GOLF_API_KEY"]
BASE_URL = "https://feeds.datagolf.com"  # TODO: confirm real base URL from docs

DB_DSN = (
    f"dbname={os.environ.get('GOLF_DB_NAME', 'golf_data')} "
    f"user={os.environ.get('GOLF_DB_USER', 'golf')} "
    f"password={os.environ.get('GOLF_DB_PASSWORD', 'changeme')} "
    f"host={os.environ.get('GOLF_DB_HOST', 'postgres-golf')} "
    f"port={os.environ.get('GOLF_DB_PORT', '5432')}"
)


def fetch_rankings() -> list[dict]:
    """TODO: replace with the real endpoint/params once API docs are confirmed."""
    resp = requests.get(
        f"{BASE_URL}/preds/skill-ratings",
        params={"key": API_KEY, "file_format": "json"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("players", [])


def load_raw(records: list[dict]) -> None:
    run_id = str(uuid.uuid4())
    with psycopg2.connect(DB_DSN) as conn:
        with conn.cursor() as cur:
            for record in records:
                cur.execute(
                    "INSERT INTO raw.data_golf_rankings (source_run_id, payload) VALUES (%s, %s)",
                    (run_id, psycopg2.extras.Json(record)),
                )
    log.info("Loaded %d records into raw.data_golf_rankings (run_id=%s)", len(records), run_id)


def main() -> None:
    log.info("Starting Data Golf ingestion")
    records = fetch_rankings()
    log.info("Fetched %d records from Data Golf API", len(records))
    load_raw(records)
    log.info("Data Golf ingestion complete")


if __name__ == "__main__":
    main()
