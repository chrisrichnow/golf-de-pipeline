# Golf Data Engineering Pipeline — Progression Log

Development milestones before the standalone repository was created. Future commits are appended by the repository's post-commit hook.

## 2026-09-04 — Local infrastructure
- Started PostgreSQL 16 in Docker and verified SQL connectivity.

## 2026-09-07 — Raw ingestion and resumable backfill
- Loaded 37 completed 2026 tournaments: 4,191 player and 74 team records.
- Added cached schedules, atomic event checkpoints, bounded source requests, and completed-event skipping.
- Verified source identities/counts, rollback, and rerun behavior.

## 2026-09-09 — Analytics and orchestration
- Added player/team result tables, season summary view, source lineage, and seven transactional quality checks.
- Ten tests passed, including live database rollback and snapshot-exclusion checks.
- Verified both an Airflow DAG test and an actual scheduler run; weekly scheduling enabled locally.

## 2026-09-09 — Dashboards and portfolio
- Built Fairway and preserved a Codex baseline. Added an independent Clubhouse alternative.
- Verified Fairway in Edge across desktop/mobile and error states.
- Prepared the portfolio README, three screenshots, silent demo recording, and resume/demo copy.
- Re-ran all ten Python tests and the Fairway browser check successfully during portfolio preparation.

- Portfolio follow-up verification: both Fairway and Clubhouse browser checks passed. Silent demo verified as 25.28 seconds at 1440x960.

## 2026-09-09 — Publish golf ELT pipeline, dashboards, and portfolio demo
`93cee11`
