-- A saved schedule avoids re-requesting it on every restart.
CREATE TABLE IF NOT EXISTS raw.slash_golf_schedules (
    org_id TEXT NOT NULL,
    season_year TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL,
    PRIMARY KEY (org_id, season_year)
);

-- One checkpoint per tournament. Completed checkpoints commit with player rows.
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS ops.slash_golf_backfill (
    org_id TEXT NOT NULL,
    season_year TEXT NOT NULL,
    tournament_id TEXT NOT NULL,
    tournament_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'failed', 'deferred')),
    source_run_id UUID,
    row_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, season_year, tournament_id)
);
