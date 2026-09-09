-- Raw staging layer: one table per source, minimal typing, full payload kept as JSONB.
-- Parsing/typing happens in transform.sql, not here — staging tables exist so a bad
-- API response never loses data, it just lands as-is and gets fixed downstream.

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS raw.slash_golf_results (
    id            BIGSERIAL PRIMARY KEY,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_run_id UUID NOT NULL,          -- ties every row back to one ingestion DAG run
    payload       JSONB NOT NULL          -- raw API response for a single result record
);

CREATE TABLE IF NOT EXISTS raw.data_golf_rankings (
    id            BIGSERIAL PRIMARY KEY,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_run_id UUID NOT NULL,
    payload       JSONB NOT NULL          -- raw API response for a single player-rating record
);

CREATE INDEX IF NOT EXISTS idx_slash_golf_results_run ON raw.slash_golf_results (source_run_id);
CREATE INDEX IF NOT EXISTS idx_data_golf_rankings_run ON raw.data_golf_rankings (source_run_id);
