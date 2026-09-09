"""Clubhouse -- a read-only browser over the golf_data warehouse.

Serves a small JSON API plus a static single-page frontend. Standard library
only (plus psycopg2, which the pipeline already depends on): no web framework,
no CDN assets, nothing to install.

    python dashboard-claude/server.py            # http://127.0.0.1:8052
    python dashboard-claude/server.py --port 9000

The database is never written to -- see warehouse.py.
"""

import argparse
import json
import sys
import threading
import time
import uuid
from datetime import date, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import warehouse

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Only these files are ever served from disk. An allowlist beats path-traversal
# checks: nothing outside it can be reached even in principle.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

CACHE_TTL_SECONDS = 60


class JSONEncoder(json.JSONEncoder):
    """Postgres types the browser cannot read natively."""

    def default(self, o):
        if isinstance(o, (datetime, date)):
            return o.isoformat()
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, uuid.UUID):
            return str(o)
        return super().default(o)


class TTLCache:
    """Results are only as fresh as the last pipeline run, so a short TTL is
    plenty and keeps repeat tab-switching instant."""

    def __init__(self, ttl):
        self.ttl = ttl
        self._lock = threading.Lock()
        self._entries = {}

    def get_or_build(self, key, builder):
        now = time.monotonic()
        with self._lock:
            hit = self._entries.get(key)
            if hit and now - hit[0] < self.ttl:
                return hit[1]
        value = builder()
        with self._lock:
            self._entries[key] = (time.monotonic(), value)
        return value

    def clear(self):
        with self._lock:
            self._entries.clear()


CACHE = TTLCache(CACHE_TTL_SECONDS)


# --------------------------------------------------------------------------
# API payload builders
# --------------------------------------------------------------------------

def build_overview():
    return {
        "inventory": warehouse.inventory(),
        "outcomes": warehouse.outcome_mix(),
        "timeline": warehouse.season_timeline(),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def build_tournaments():
    return {"tournaments": warehouse.tournaments()}


def build_players():
    return {"players": warehouse.players()}


def build_scoring():
    profile = warehouse.round_profile()
    return {
        "courses": warehouse.course_difficulty(),
        "by_round": profile["by_round"],
        "distribution": profile["distribution"],
        "low_rounds": profile["low_rounds"],
    }


def build_pipeline():
    return warehouse.pipeline_health()


ROUTES = {
    "/api/overview": build_overview,
    "/api/tournaments": build_tournaments,
    "/api/players": build_players,
    "/api/scoring": build_scoring,
    "/api/pipeline": build_pipeline,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Clubhouse"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers ---------------------------------------------------------
    def _send(self, status, body, content_type):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload, status=200):
        self._send(status, json.dumps(payload, cls=JSONEncoder), "application/json; charset=utf-8")

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path in STATIC_FILES:
                return self._serve_static(path)
            if path in ROUTES:
                payload = CACHE.get_or_build(path, ROUTES[path])
                return self._send_json(payload)
            if path == "/api/refresh":
                CACHE.clear()
                return self._send_json({"ok": True, "refreshed_at": datetime.now().isoformat(timespec="seconds")})
            if path.startswith("/api/tournaments/"):
                tid = path.rsplit("/", 1)[-1]
                return self._send_json(
                    CACHE.get_or_build(path, lambda: warehouse.tournament_leaderboard(tid))
                )
            if path.startswith("/api/players/"):
                pid = path.rsplit("/", 1)[-1]
                return self._send_json(
                    CACHE.get_or_build(path, lambda: warehouse.player_detail(pid))
                )
            self._send_json({"error": "not found", "path": path}, status=404)
        except Exception as exc:  # surface the real cause in the UI, not a blank page
            self.log_message("error on %s: %s", path, exc)
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    def _serve_static(self, path):
        name, content_type = STATIC_FILES[path]
        target = STATIC_DIR / name
        if not target.is_file():
            return self._send_json({"error": f"missing static file {name}"}, status=404)
        self._send(200, target.read_bytes(), content_type)


def main():
    parser = argparse.ArgumentParser(description="Clubhouse golf warehouse dashboard")
    parser.add_argument("--port", type=int, default=8052)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    try:
        counts = warehouse.inventory()
    except Exception as exc:
        print(f"Cannot reach the golf_data database: {exc}")
        print("Is the postgres-golf container running?  docker compose ps")
        return 1

    print("Clubhouse -- golf warehouse dashboard")
    print(
        f"  {counts['player_results']:,} player results  |  "
        f"{counts['round_records']:,} round scores  |  "
        f"{counts['tournaments']} tournaments  |  {counts['players']} players"
    )
    print(f"  http://{args.host}:{args.port}")
    print("  Ctrl+C to stop.  Database access is read-only.")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
