-- ESPN leaderboards for tours Slash Golf does not cover (DP World, LIV, Korn Ferry, Champions).
-- One raw row = one final tournament leaderboard, stored as returned.
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS raw.espn_golf_leaderboards (
    id            BIGSERIAL PRIMARY KEY,
    league        TEXT NOT NULL,
    season_year   TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload       JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS ops.espn_golf_backfill (
    league        TEXT NOT NULL,
    season_year   TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    event_name    TEXT,
    status        TEXT NOT NULL CHECK (status IN ('complete', 'failed', 'deferred')),
    raw_id        BIGINT REFERENCES raw.espn_golf_leaderboards (id),
    row_count     INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (league, season_year, event_id)
);
