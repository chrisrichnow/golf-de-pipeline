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
-- Older team events (e.g. 2024 Zurich, Grant Thornton, QBE Shootout) arrive as one "player"
-- per team with a combined "A/ B" name and a team ID in playerId; classify those as teams.
CREATE OR REPLACE VIEW analytics.completed_results AS
SELECT r.id AS raw_id, r.source_run_id, r.ingested_at, r.payload,
 b.org_id, b.season_year, b.tournament_id, b.tournament_name,
 CASE WHEN r.payload ? 'team' THEN 'team'
  WHEN concat_ws(' ', r.payload #>> '{player,firstName}', r.payload #>> '{player,lastName}') ~ '/' THEN 'combined_team'
  WHEN r.payload ? 'player' THEN 'player' END AS result_kind
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
 payload #>> '{player,total}',
 -- Stableford totals are points, not strokes relative to par.
 CASE WHEN payload #>> '{schedule,format}' = 'stableford' THEN NULL
 ELSE analytics.score_to_par(payload #>> '{player,total}') END,
 payload #>> '{player,status}',
 jsonb_array_length(coalesce(payload #> '{player,rounds}', '[]'::jsonb)),
 raw_id, source_run_id, ingested_at
FROM analytics.completed_results WHERE result_kind = 'player';
INSERT INTO analytics.team_results
SELECT org_id, season_year, tournament_id, payload #>> '{team,teamId}',
 tournament_name, analytics.event_date(payload #> '{schedule,date,end}'),
 payload #> '{team,players}', payload #>> '{team,position}',
 payload #>> '{team,total}', analytics.score_to_par(payload #>> '{team,total}'),
 raw_id, source_run_id, ingested_at
FROM analytics.completed_results WHERE result_kind = 'team'
UNION ALL
-- Combined-name teams carry no individual player IDs, only surnames.
SELECT org_id, season_year, tournament_id, payload #>> '{player,playerId}',
 tournament_name, analytics.event_date(payload #> '{schedule,date,end}'),
 (SELECT jsonb_agg(jsonb_build_object('firstName', '', 'lastName', trim(name)))
  FROM regexp_split_to_table(concat_ws(' ', payload #>> '{player,firstName}', payload #>> '{player,lastName}'), '/') name
  WHERE trim(name) <> ''),
 payload #>> '{player,position}',
 payload #>> '{player,total}', analytics.score_to_par(payload #>> '{player,total}'),
 raw_id, source_run_id, ingested_at
FROM analytics.completed_results WHERE result_kind = 'combined_team';
-- Other tours from ESPN. org_id carries the tour (eur, liv, ntw, champions-tour); player IDs are
-- prefixed so ESPN athlete IDs can never collide with PGA TOUR IDs.
CREATE TABLE IF NOT EXISTS raw.espn_golf_leaderboards (id BIGSERIAL PRIMARY KEY, league TEXT NOT NULL,
 season_year TEXT NOT NULL, event_id TEXT NOT NULL, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS ops.espn_golf_backfill (league TEXT NOT NULL, season_year TEXT NOT NULL, event_id TEXT NOT NULL,
 event_name TEXT, status TEXT NOT NULL, raw_id BIGINT, row_count INTEGER NOT NULL DEFAULT 0, error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (league, season_year, event_id));
-- Read each (compressed) leaderboard once per event, not once per competitor row.
CREATE OR REPLACE VIEW analytics.espn_competitors AS
WITH events AS MATERIALIZED (
 SELECT b.league, b.season_year, b.event_id, r.id AS raw_id, r.ingested_at,
  r.payload ->> 'name' AS tournament_name, left(r.payload ->> 'endDate', 10)::date AS event_end_date,
  r.payload -> 'competitions' -> 0 -> 'competitors' AS competitors
 FROM ops.espn_golf_backfill b JOIN raw.espn_golf_leaderboards r ON r.id = b.raw_id
 WHERE b.status = 'complete')
SELECT league, season_year, event_id, raw_id, ingested_at, tournament_name, event_end_date, c
FROM events CROSS JOIN LATERAL jsonb_array_elements(competitors) c;
-- Unpack each ESPN leaderboard once into plain columns; carrying full competitor JSON is slow.
CREATE TEMP TABLE espn_rows ON COMMIT DROP AS
SELECT league, season_year, event_id, raw_id, ingested_at, tournament_name, event_end_date,
 c #>> '{athlete,id}' AS athlete_id, c #>> '{athlete,displayName}' AS player_name,
 c #>> '{status,type,name}' AS status_name, c #>> '{status,position,displayName}' AS position,
 coalesce(nullif(c #>> '{status,displayValue}', ''), c #>> '{status,type,shortDetail}') AS status_value,
 c #>> '{status,type,description}' AS status_description, c #>> '{score,displayValue}' AS score_text,
 (SELECT count(*) FROM jsonb_array_elements(coalesce(c -> 'linescores', '[]'::jsonb)) l WHERE l ? 'value')::integer AS rounds_played,
 c #>> '{athlete,flag,alt}' AS country, c #>> '{athlete,flag,href}' AS flag_href
FROM analytics.espn_competitors;
INSERT INTO analytics.player_results
SELECT league, season_year, event_id, 'espn-' || athlete_id, tournament_name, event_end_date, player_name,
 CASE WHEN status_name = 'STATUS_FINISH' THEN position ELSE status_value END,
 CASE WHEN status_name = 'STATUS_FINISH' AND position ~ '^T?[0-9]{1,3}$' THEN replace(position, 'T', '')::integer END,
 score_text, analytics.score_to_par(score_text), status_description, rounds_played,
 raw_id, '00000000-0000-0000-0000-000000000000'::uuid, ingested_at
FROM espn_rows;
DROP VIEW IF EXISTS analytics.espn_player_directory;
CREATE TABLE IF NOT EXISTS analytics.espn_player_countries (
 player_id TEXT PRIMARY KEY, country TEXT NOT NULL, country_code TEXT);
DELETE FROM analytics.espn_player_countries;
INSERT INTO analytics.espn_player_countries
SELECT DISTINCT ON (athlete_id) 'espn-' || athlete_id, country, upper(substring(flag_href from '/([A-Za-z]{2,3})\.png$'))
FROM espn_rows WHERE country IS NOT NULL
ORDER BY athlete_id, event_end_date DESC;
-- Latest directory snapshot only; players absent from it simply have no country.
CREATE OR REPLACE VIEW analytics.player_directory AS
SELECT DISTINCT ON (payload ->> 'id') payload ->> 'id' AS player_id,
 payload ->> 'displayName' AS display_name,
 nullif(trim(payload ->> 'country'), '') AS country,
 nullif(upper(trim(payload ->> 'countryFlag')), '') AS country_code,
 ingested_at
FROM raw.pga_tour_player_directory
WHERE source_run_id = (SELECT source_run_id FROM raw.pga_tour_player_directory ORDER BY ingested_at DESC, id DESC LIMIT 1)
ORDER BY payload ->> 'id', id DESC;
CREATE OR REPLACE VIEW analytics.player_season_summary AS
SELECT org_id, season_year, player_id,
 (array_agg(player_name ORDER BY event_end_date DESC, tournament_id))[1] AS player_name,
 count(*) AS events_played, count(*) FILTER (WHERE finish_rank = 1) AS wins,
 count(*) FILTER (WHERE finish_rank <= 10) AS top_10s,
 count(*) FILTER (WHERE finish_position = 'CUT') AS cuts,
 max(event_end_date) AS latest_event_date
FROM analytics.player_results GROUP BY org_id, season_year, player_id;
-- Fresh statistics so the quality checks that follow get good query plans.
ANALYZE analytics.player_results;
ANALYZE analytics.team_results;
