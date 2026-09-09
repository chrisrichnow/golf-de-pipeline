-- Run in a transaction. Only completed backfill snapshots feed analytics.
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE OR REPLACE FUNCTION analytics.score_to_par(value TEXT)
RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
SELECT CASE WHEN upper(trim(value)) = 'E' THEN 0
 WHEN trim(value) ~ '^[+-]?[0-9]{1,3}$' THEN trim(value)::integer ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION analytics.event_date(value JSONB)
RETURNS DATE LANGUAGE SQL IMMUTABLE AS $$
SELECT CASE WHEN value #>> '{$date,$numberLong}' IS NOT NULL
 THEN (to_timestamp((value #>> '{$date,$numberLong}')::numeric / 1000) AT TIME ZONE 'UTC')::date
 WHEN jsonb_typeof(value -> '$date') = 'number'
 THEN (to_timestamp((value ->> '$date')::numeric / 1000) AT TIME ZONE 'UTC')::date
 ELSE left(coalesce(value ->> '$date', value #>> '{}'), 10)::date END
$$;
CREATE OR REPLACE VIEW analytics.completed_results AS
SELECT r.id AS raw_id, r.source_run_id, r.ingested_at, r.payload,
 b.org_id, b.season_year, b.tournament_id, b.tournament_name
FROM raw.slash_golf_results r JOIN ops.slash_golf_backfill b
 ON b.source_run_id = r.source_run_id
 AND b.org_id = r.payload #>> '{tournament,orgId}'
 AND b.season_year = r.payload #>> '{tournament,year}'
 AND b.tournament_id = r.payload #>> '{tournament,tournId}'
WHERE b.status = 'complete';
CREATE TABLE IF NOT EXISTS analytics.player_results (
 org_id TEXT NOT NULL, season_year TEXT NOT NULL, tournament_id TEXT NOT NULL,
 player_id TEXT NOT NULL, tournament_name TEXT NOT NULL, event_end_date DATE NOT NULL,
 player_name TEXT NOT NULL, finish_position TEXT, finish_rank INTEGER,
 score_text TEXT, score_to_par INTEGER, player_status TEXT, rounds_played INTEGER NOT NULL,
 raw_id BIGINT NOT NULL, source_run_id UUID NOT NULL, ingested_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (org_id, season_year, tournament_id, player_id)
);
CREATE TABLE IF NOT EXISTS analytics.team_results (
 org_id TEXT NOT NULL, season_year TEXT NOT NULL, tournament_id TEXT NOT NULL,
 team_id TEXT NOT NULL, tournament_name TEXT NOT NULL, event_end_date DATE NOT NULL,
 players JSONB NOT NULL, finish_position TEXT, score_text TEXT, score_to_par INTEGER,
 raw_id BIGINT NOT NULL, source_run_id UUID NOT NULL, ingested_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY (org_id, season_year, tournament_id, team_id)
);
-- Atomically replace derived data while retaining raw records and checkpoints.
DELETE FROM analytics.player_results;
DELETE FROM analytics.team_results;
INSERT INTO analytics.player_results
SELECT org_id, season_year, tournament_id, payload #>> '{player,playerId}',
 tournament_name, analytics.event_date(payload #> '{schedule,date,end}'),
 concat_ws(' ', payload #>> '{player,firstName}', payload #>> '{player,lastName}'),
 payload #>> '{player,position}',
 CASE WHEN payload #>> '{player,position}' ~ '^T?[0-9]{1,3}$'
 THEN replace(payload #>> '{player,position}', 'T', '')::integer END,
 payload #>> '{player,total}', analytics.score_to_par(payload #>> '{player,total}'),
 payload #>> '{player,status}',
 jsonb_array_length(coalesce(payload #> '{player,rounds}', '[]'::jsonb)),
 raw_id, source_run_id, ingested_at
FROM analytics.completed_results WHERE payload ? 'player';
INSERT INTO analytics.team_results
SELECT org_id, season_year, tournament_id, payload #>> '{team,teamId}',
 tournament_name, analytics.event_date(payload #> '{schedule,date,end}'),
 payload #> '{team,players}', payload #>> '{team,position}',
 payload #>> '{team,total}', analytics.score_to_par(payload #>> '{team,total}'),
 raw_id, source_run_id, ingested_at
FROM analytics.completed_results WHERE payload ? 'team';
CREATE OR REPLACE VIEW analytics.player_season_summary AS
SELECT org_id, season_year, player_id,
 (array_agg(player_name ORDER BY event_end_date DESC, tournament_id))[1] AS player_name,
 count(*) AS events_played, count(*) FILTER (WHERE finish_rank = 1) AS wins,
 count(*) FILTER (WHERE finish_rank <= 10) AS top_10s,
 count(*) FILTER (WHERE finish_position = 'CUT') AS cuts,
 max(event_end_date) AS latest_event_date
FROM analytics.player_results GROUP BY org_id, season_year, player_id;
