# Resume and portfolio copy

## Resume entry

**Golf Data Engineering Pipeline** | Python, PostgreSQL, SQL, Apache Airflow, Docker

- Built an ELT pipeline ingesting 4,265 player/team result records across 37 completed PGA Tour events, preserving raw JSONB and transforming it into analytics tables covering 572 players.
- Implemented resumable tournament checkpoints, atomic loads, source lineage, and seven pre-publication data checks; verified behavior with ten automated tests, including rollback and duplicate-snapshot exclusion.
- Orchestrated weekly ingestion and SQL transformations with Airflow and delivered interactive dashboards for player histories, tournament results, and season summaries.

## Short version

Built a Python/PostgreSQL golf ELT pipeline processing 4,265 results across 37 events, with resumable ingestion, transactional SQL quality checks, weekly Airflow orchestration, and interactive dashboards.

## Portfolio card

**Title:** Golf Data Engineering Pipeline

**Description:** A local data pipeline that turns nested PGA Tour API responses into reliable player and tournament analytics. Includes raw-data preservation, resumable ingestion, tested SQL transformations, Airflow scheduling, and two interactive dashboards.

**Tags:** Python · PostgreSQL · SQL · Airflow · Docker · Data quality

## Interview introduction (about 30 seconds)

“I built a golf data pipeline to practice the full data engineering workflow. It pulls tournament results from an API, preserves the raw JSON in Postgres, and transforms it into player and team analytics. The interesting part was making the data reliable: a team score cannot count as an individual score, and rerunning a completed tournament should not duplicate its results. I used transactional checkpoints and quality checks to handle those cases, then automated the sequence with Airflow and built dashboards to explore it.”

## Claim boundaries

- Counts describe the verified September 9, 2026 dataset; this is a local portfolio project, not a production system or an official PGA statistics product.
- Airflow scheduling requires the computer and Docker to be running.
- Data Golf, S3, Snowflake, streaming ingestion, and cloud deployment were not implemented.
- Implementation used AI assistance. Explain the architecture and tradeoffs in your own words; do not describe the work as independently hand-coded or claim mastery of every tool.
- This entry is separate from the existing golf prediction-model project. They are different projects and should not have their scope or metrics combined.
