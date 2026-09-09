# Golf Data Engineering Pipeline

A local ELT pipeline that turns nested PGA Tour API responses into queryable player and tournament analytics, with resumable ingestion, transactional data checks, and interactive dashboards.

**Python · PostgreSQL · SQL · Apache Airflow · Docker · JavaScript**

![Fairway season overview](docs/portfolio/fairway-overview.png)

[Watch the dashboard preview](docs/portfolio/dashboard-demo.webm) · [Two-minute demo walkthrough](docs/portfolio/demo-walkthrough.md) · [Resume and portfolio copy](docs/portfolio/resume-entry.md)

## The problem

Tournament responses contain nested player/round data, tied finishes, withdrawals, and team events. Loading them repeatedly can duplicate results; treating a team's score as an individual's can distort season statistics. This project preserves the original source and publishes validated analytics at an explicit player/tournament or team/tournament grain.

## What is working

Verified September 9, 2026:

| Dataset | Count |
|---|---:|
| Completed 2026 events | 37 |
| Player-result records | 4,191 |
| Team-result records | 74 |
| Players in individual-event analytics | 572 |
| Quality checks before analytics commit | 7 |
| Passing ingestion/transformation tests | 10 |

The source schedule was refreshed September 9; the latest loaded event ended August 30. Twelve scheduled events were still in the future. Counts describe this loaded dataset, not an independently verified official PGA statistics feed.

## Architecture

```mermaid
flowchart LR
    API[Slash Golf API] --> Python[Python ingestion]
    Python --> Raw[Postgres: raw JSONB]
    Python --> Ops[Transactional event checkpoints]
    Raw --> SQL[SQL transformations]
    Ops --> SQL
    SQL --> Checks[Quality checks]
    Checks --> Analytics[Player and team analytics]
    Analytics --> UI[Interactive dashboards]
    Airflow[Airflow: weekly orchestration] -. runs .-> Python
    Airflow -. runs .-> SQL
```

- **Extract and load:** cache the schedule, request only pending completed events, and accept Official leaderboards. Save each event's raw records and its checkpoint in one transaction.
- **Transform:** use completed checkpoint snapshots, extract typed fields, convert even par to zero, retain tie/withdrawal labels, and separate team scores from individual scores.
- **Validate and publish:** rebuild derived tables and run seven checks in one transaction. Failed validation rolls back the rebuild and preserves prior analytics.
- **Orchestrate:** Airflow runs ingestion before transformation, with a ten-request execution cap and no automatic API retries. A separate Postgres instance stores Airflow metadata.
- **Explore:** dashboards use read-only database transactions. Dashboard refreshes spend no source API requests.

### Data model

| Object | Grain / purpose |
|---|---|
| `raw.slash_golf_results` | Original player or team snapshot in JSONB |
| `raw.slash_golf_schedules` | Cached schedule per tour/year |
| `ops.slash_golf_backfill` | Load status per tournament |
| `analytics.player_results` | One player per completed tournament |
| `analytics.team_results` | One team per completed tournament |
| `analytics.player_season_summary` | Individual-event season totals per player |

Result keys use IDs rather than names. Cleaned rows retain source run IDs and raw record IDs. The independent 2024 ingestion demo and learning-script snapshots remain in raw storage but are excluded from the completed-backfill analytics.

## Dashboards

**Fairway** is the featured dashboard: season leaders, searchable/sortable player standings, tournament leaderboards, player history charts, and filtered CSV exports.

| Version | Folder | Default / suggested port |
|---|---|---:|
| Fairway working version | `dashboard/` | 8050 |
| Preserved Codex baseline | `dashboard-codex/` | 8051 with `--port 8051` |
| Clubhouse alternative | `dashboard-claude/` | 8052 |

Clubhouse also exposes raw round-level data, course/round scoring views, and pipeline coverage. See [its README](dashboard-claude/README.md) for details and scoring caveats.

![Fairway player history](docs/portfolio/fairway-player.png)

The Codex baseline is preserved with hashes and screenshots. Keep future comparison work separate from `dashboard-codex/`. Both dashboard versions were built with AI assistance; the shared pipeline is the project's core engineering deliverable.

## Quick start — Windows / PowerShell

Prerequisites: Docker Desktop running, Python (3.11+; development used 3.14 locally and 3.11 inside Airflow), and Slash Golf API access through RapidAPI for a first real-data load. No database dump or API credentials are bundled.

Run the following **from the project root**. For a fresh checkout:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Fill in `SLASH_GOLF_API_KEY` and local database passwords in `.env`. Preserve an existing `.env`; do not run the copy command over your current configuration. Keep Airflow database credentials URL-safe because Compose embeds them in a connection URL.

Start the golf database:

```powershell
docker compose up -d postgres-golf
docker compose ps
```

Load a bounded first batch and build analytics:

```powershell
.\.venv\Scripts\python.exe pipeline.py --year 2026 --as-of 2026-09-09 --max-requests 60 --refresh-schedule
```

This may spend up to 60 API requests. Check your provider allowance first. The fixed cutoff reproduces this project's event eligibility window, but a later provider response can contain corrected data. The command creates schemas/tables on a fresh database. If it stops at its cap, completed events stay saved; rerun without `--refresh-schedule` to resume from the cached schedule.

If this project already has its data, rebuild analytics **without API requests** instead:

```powershell
.\.venv\Scripts\python.exe pipeline.py --transform-only
```

Start the featured dashboard:

```powershell
.\.venv\Scripts\python.exe dashboard/server.py
```

Open **http://localhost:8050**. Keep the terminal running; Ctrl+C stops the dashboard. Postgres must remain running. For Clubhouse, use `dashboard-claude/server.py` in a separate terminal and open port 8052.

### Airflow

```powershell
docker compose up -d --build airflow-webserver airflow-scheduler
```

Open http://localhost:8080 and sign in with the admin values from `.env`. A fresh installation starts with the DAG paused. To enable it:

```powershell
docker compose exec airflow-scheduler airflow dags unpause golf_pipeline
```

The `golf_pipeline` DAG targets the 2026 season and runs **Tuesdays at 8 a.m. America/Chicago**, while the computer and Docker are running. It refreshes the schedule, allows up to ten API requests per run, and does not automatically retry source requests. `catchup=False` avoids replaying every missed interval. The existing development installation was enabled and its first scheduled run succeeded.

Run or pause it explicitly:

```powershell
docker compose exec airflow-scheduler airflow dags trigger golf_pipeline
docker compose exec airflow-scheduler airflow dags pause golf_pipeline
```

To stop the Airflow processes while retaining the golf database:

```powershell
docker compose stop airflow-scheduler airflow-webserver
```

Named Docker volumes retain both databases. Removing volumes deletes their stored data; stopping/restarting does not require removing them.

## Tests and sample queries

Six offline tests run by default; four database integration tests skip unless opted in:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

After loading data and building analytics, include the database checks:

```powershell
$env:GOLF_TEST_DATABASE = '1'
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
Remove-Item Env:GOLF_TEST_DATABASE
```

Database test mutations roll back. These tests cover score/date formats, missing-row detection, independent-snapshot exclusion, and failed-rebuild rollback. The earlier Airflow DAG test and scheduler run also succeeded.

Browser checks require Node.js, the pinned Playwright dependency, Microsoft Edge, and the corresponding dashboard server running:

```powershell
npm.cmd install
npm.cmd run test:dashboard
# For Clubhouse, with its server running:
npm.cmd run test:clubhouse
```

Fairway's check covers data counts, filtering, CSV contents, player/tournament navigation, team separation, pagination, refresh, mobile layouts, and database-error handling.

Run demonstration SQL:

```powershell
Get-Content sql/demo_queries.sql -Raw | docker compose exec -T postgres-golf psql -U golf -d golf_data -v ON_ERROR_STOP=1
```

## Scope and limitations

- This is a local learning/portfolio project. It has not been deployed or operated as a production service.
- Data Golf enrichment is not implemented; its source file is a labeled placeholder. S3/Snowflake and a lakehouse are not part of this version.
- The execution request cap is not a monthly quota tracker. Completed events are not automatically reloaded when the provider corrects results.
- Season summaries cover loaded individual events only. Scores across different courses/round counts are not adjusted performance ratings.
- The dashboard source is preserved; the database remains live and can change with future loads.
- Failed or deferred ingestion prevents the downstream transformation. Review Airflow task logs or `logs/ingest_slash_golf.log`, resolve the issue, and rerun.

## Repository map

```text
config/              Shared Python logging
ingestion/          API ingestion and resumable backfill
sql/                Schemas, transformations, checks, demo queries
dags/               Airflow DAG
dashboard/          Fairway UI and read-only local server
dashboard-codex/    Preserved Fairway baseline
dashboard-claude/   Clubhouse alternative dashboard
tests/              Python ingestion/transformation tests
scripts/            Demo recording utilities
docs/portfolio/     Screenshots, recorded preview, walkthrough, resume copy
pipeline.py         Local entry point
docker-compose.yml  Golf Postgres + Airflow + metadata Postgres
```

Progress and earlier verification are recorded in `PROGRESSION.md`. Local workspace handoffs are retained separately in the development workspace.

References: [Airflow 2.10.4 Docker setup](https://airflow.apache.org/docs/apache-airflow/2.10.4/howto/docker-compose/index.html) · [DAG scheduling](https://airflow.apache.org/docs/apache-airflow/2.10.4/core-concepts/dag-run.html)
