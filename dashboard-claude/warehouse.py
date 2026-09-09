"""Read-only data access for the Clubhouse dashboard.

Every query runs inside a READ ONLY transaction. This module creates no tables,
views, or functions -- the warehouse is treated as a published artifact that the
dashboard only reads.

Grain note: analytics.player_results is one row per player per event. The
round-by-round grain (one row per player per round) exists only inside the raw
JSONB payload, so ROUND_GRAIN unnests it at query time. Materializing that as
analytics.round_results is the natural next pipeline step; doing it here would
mean writing to the database, which this dashboard deliberately does not do.
"""

import os
import threading
from pathlib import Path

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool

try:
    from dotenv import load_dotenv
except ImportError:  # dotenv is optional; env vars still work without it
    load_dotenv = None

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    if load_dotenv is not None:
        load_dotenv(PROJECT_ROOT / ".env")


_POOL = None
_POOL_LOCK = threading.Lock()


def _get_pool():
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                _load_env()
                _POOL = pgpool.ThreadedConnectionPool(
                    minconn=1,
                    maxconn=6,
                    host=os.getenv("GOLF_DB_HOST", "localhost"),
                    port=os.getenv("GOLF_DB_PORT", "5433"),
                    dbname=os.getenv("GOLF_DB_NAME", "golf_data"),
                    user=os.getenv("GOLF_DB_USER", "golf"),
                    password=os.getenv("GOLF_DB_PASSWORD", "changeme"),
                    connect_timeout=5,
                    application_name="clubhouse-dashboard",
                )
    return _POOL


def query(sql, params=None):
    """Run one SQL statement in a read-only transaction and return dict rows."""
    connection = _get_pool().getconn()
    try:
        connection.set_session(readonly=True, autocommit=False)
        with connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
            cursor.execute(sql, params or ())
            rows = [dict(row) for row in cursor.fetchall()]
        connection.rollback()
        return rows
    except Exception:
        connection.rollback()
        raise
    finally:
        _get_pool().putconn(connection)


def query_one(sql, params=None):
    rows = query(sql, params)
    return rows[0] if rows else {}


# --------------------------------------------------------------------------
# Reusable SQL fragments
# --------------------------------------------------------------------------

# One row per player per round, unnested from the raw payload.
ROUND_GRAIN = """
WITH rounds AS (
    SELECT cr.tournament_id,
           cr.tournament_name,
           cr.season_year,
           cr.payload #>> '{player,playerId}'                  AS player_id,
           concat_ws(' ', cr.payload #>> '{player,firstName}',
                          cr.payload #>> '{player,lastName}')  AS player_name,
           r ->> 'courseName'                                  AS course_name,
           (r #>> '{roundId,$numberInt}')::int                 AS round_no,
           (r #>> '{strokes,$numberInt}')::int                 AS strokes,
           analytics.score_to_par(r ->> 'scoreToPar')          AS score_to_par
    FROM analytics.completed_results cr,
         LATERAL jsonb_array_elements(cr.payload #> '{player,rounds}') r
    WHERE cr.payload ? 'player'
)
"""

# One row per tournament, pulling event metadata out of the raw payload.
EVENT_META = """
WITH meta AS (
    SELECT tournament_id,
           max(payload #>> '{schedule,name}')                             AS schedule_name,
           max((payload #>> '{schedule,purse,$numberInt}')::bigint)        AS purse,
           max((payload #>> '{schedule,winnersShare,$numberInt}')::bigint) AS winners_share,
           max((payload #>> '{schedule,fedexCupPoints,$numberInt}')::int)  AS fedex_points,
           max(payload #>> '{schedule,format}')                            AS format,
           max(payload #>> '{schedule,date,weekNumber}')                   AS week_number,
           max(payload #>> '{tournament,cutLines,0,cutScore}')             AS cut_score,
           max((payload #>> '{tournament,cutLines,0,cutCount,$numberInt}')::int) AS cut_count
    FROM analytics.completed_results
    GROUP BY tournament_id
)
"""


# --------------------------------------------------------------------------
# Overview
# --------------------------------------------------------------------------

def inventory():
    counts = query_one(
        """
        SELECT
          (SELECT count(*) FROM raw.slash_golf_results)                          AS raw_results,
          (SELECT count(DISTINCT source_run_id) FROM raw.slash_golf_results)     AS raw_runs,
          (SELECT count(*) FROM raw.slash_golf_schedules)                        AS raw_schedules,
          (SELECT count(*) FROM ops.slash_golf_backfill)                         AS checkpoints,
          (SELECT count(*) FROM ops.slash_golf_backfill WHERE status = 'complete') AS checkpoints_complete,
          (SELECT count(*) FROM analytics.player_results)                        AS player_results,
          (SELECT count(*) FROM analytics.team_results)                          AS team_results,
          (SELECT count(*) FROM analytics.player_season_summary)                 AS season_rows,
          (SELECT count(DISTINCT player_id) FROM analytics.player_results)       AS players,
          (SELECT count(DISTINCT tournament_id) FROM analytics.player_results)   AS tournaments,
          (SELECT min(event_end_date) FROM analytics.player_results)             AS first_event,
          (SELECT max(event_end_date) FROM analytics.player_results)             AS last_event,
          (SELECT max(ingested_at) FROM raw.slash_golf_results)                  AS last_ingest,
          (SELECT max(fetched_at) FROM raw.slash_golf_schedules)                 AS schedule_fetched,
          (SELECT count(*) FROM raw.slash_golf_results r
             WHERE NOT EXISTS (SELECT 1 FROM analytics.completed_results c WHERE c.raw_id = r.id)
          ) AS raw_excluded,
          (SELECT coalesce(sum(jsonb_array_length(payload -> 'schedule')), 0)
             FROM raw.slash_golf_schedules)                                      AS scheduled_events
        """
    )
    grain = query_one(
        ROUND_GRAIN
        + """
        SELECT count(*) AS round_records,
               count(DISTINCT course_name) AS courses,
               sum(strokes) AS total_strokes
        FROM rounds
        """
    )
    counts.update(grain)
    return counts


def outcome_mix():
    return query(
        """
        SELECT coalesce(player_status, 'unknown') AS status,
               count(*) AS results
        FROM analytics.player_results
        GROUP BY 1
        ORDER BY 2 DESC
        """
    )


def season_timeline():
    return query(
        EVENT_META
        + """
        SELECT p.tournament_id,
               p.tournament_name,
               p.event_end_date,
               count(*)                                             AS field_size,
               count(*) FILTER (WHERE p.finish_position = 'CUT')     AS missed_cut,
               m.purse,
               m.format
        FROM analytics.player_results p
        LEFT JOIN meta m ON m.tournament_id = p.tournament_id
        GROUP BY p.tournament_id, p.tournament_name, p.event_end_date, m.purse, m.format
        ORDER BY p.event_end_date
        """
    )


# --------------------------------------------------------------------------
# Tournaments
# --------------------------------------------------------------------------

def tournaments():
    return query(
        EVENT_META
        + """
        , courses AS (
            SELECT cr.tournament_id,
                   count(DISTINCT r ->> 'courseName')                                 AS course_count,
                   (array_agg(DISTINCT r ->> 'courseName'))[1]                        AS course_name
            FROM analytics.completed_results cr,
                 LATERAL jsonb_array_elements(cr.payload #> '{player,rounds}') r
            WHERE cr.payload ? 'player'
            GROUP BY cr.tournament_id
        )
        SELECT p.tournament_id,
               p.tournament_name,
               p.event_end_date,
               count(*)                                                    AS field_size,
               count(*) FILTER (WHERE p.finish_position = 'CUT')            AS missed_cut,
               count(*) FILTER (WHERE p.player_status = 'complete')         AS made_cut,
               min(p.score_to_par) FILTER (WHERE p.finish_rank = 1)         AS winning_score,
               (array_agg(p.player_name ORDER BY p.finish_rank NULLS LAST, p.player_name)
                  FILTER (WHERE p.finish_rank = 1))[1]                      AS winner,
               count(*) FILTER (WHERE p.finish_rank = 1)                    AS winner_count,
               m.purse,
               m.winners_share,
               m.fedex_points,
               m.format,
               m.cut_score,
               c.course_count,
               c.course_name,
               (SELECT count(*) FROM analytics.team_results t
                 WHERE t.tournament_id = p.tournament_id)                   AS team_rows
        FROM analytics.player_results p
        LEFT JOIN meta m   ON m.tournament_id = p.tournament_id
        LEFT JOIN courses c ON c.tournament_id = p.tournament_id
        GROUP BY p.tournament_id, p.tournament_name, p.event_end_date,
                 m.purse, m.winners_share, m.fedex_points, m.format, m.cut_score,
                 c.course_count, c.course_name
        ORDER BY p.event_end_date DESC
        """
    )


def tournament_leaderboard(tournament_id):
    players = query(
        ROUND_GRAIN
        + """
        , agg AS (
            SELECT player_id,
                   sum(strokes) AS total_strokes,
                   jsonb_agg(jsonb_build_object('round', round_no, 'strokes', strokes,
                                                'toPar', score_to_par, 'course', course_name)
                             ORDER BY round_no) AS round_detail
            FROM rounds
            WHERE tournament_id = %(tid)s
            GROUP BY player_id
        )
        SELECT p.player_id,
               p.player_name,
               p.finish_position,
               p.finish_rank,
               p.score_to_par,
               p.score_text,
               p.player_status,
               p.rounds_played,
               a.total_strokes,
               a.round_detail
        FROM analytics.player_results p
        LEFT JOIN agg a ON a.player_id = p.player_id
        WHERE p.tournament_id = %(tid)s
        ORDER BY p.finish_rank NULLS LAST, p.player_name
        """,
        {"tid": tournament_id},
    )
    teams = query(
        """
        SELECT team_id, finish_position, score_to_par, score_text, players
        FROM analytics.team_results
        WHERE tournament_id = %(tid)s
        ORDER BY nullif(regexp_replace(coalesce(finish_position, ''), '\\D', '', 'g'), '')::int
                 NULLS LAST, team_id
        """,
        {"tid": tournament_id},
    )
    header = query_one(
        EVENT_META
        + """
        SELECT p.tournament_id, p.tournament_name, p.event_end_date,
               m.purse, m.winners_share, m.fedex_points, m.format, m.cut_score, m.week_number
        FROM analytics.player_results p
        LEFT JOIN meta m ON m.tournament_id = p.tournament_id
        WHERE p.tournament_id = %(tid)s
        GROUP BY p.tournament_id, p.tournament_name, p.event_end_date,
                 m.purse, m.winners_share, m.fedex_points, m.format, m.cut_score, m.week_number
        """,
        {"tid": tournament_id},
    )
    return {"header": header, "players": players, "teams": teams}


# --------------------------------------------------------------------------
# Players
# --------------------------------------------------------------------------

def players():
    return query(
        ROUND_GRAIN
        + """
        , scoring AS (
            SELECT player_id,
                   round(avg(strokes)::numeric, 2) AS scoring_avg,
                   count(*)                        AS rounds_logged
            FROM rounds
            GROUP BY player_id
        )
        SELECT s.player_id,
               s.player_name,
               s.events_played,
               s.wins,
               s.top_10s,
               s.cuts,
               s.latest_event_date,
               sc.scoring_avg,
               sc.rounds_logged,
               (SELECT min(finish_rank) FROM analytics.player_results pr
                 WHERE pr.player_id = s.player_id)  AS best_finish
        FROM analytics.player_season_summary s
        LEFT JOIN scoring sc ON sc.player_id = s.player_id
        ORDER BY s.wins DESC, s.top_10s DESC, s.events_played DESC, s.player_name
        """
    )


def player_detail(player_id):
    summary = query_one(
        ROUND_GRAIN
        + """
        , scoring AS (
            SELECT player_id,
                   round(avg(strokes)::numeric, 2)      AS scoring_avg,
                   round(avg(score_to_par)::numeric, 2) AS avg_to_par,
                   count(*)                             AS rounds_logged,
                   min(strokes)                         AS best_round
            FROM rounds
            WHERE player_id = %(pid)s
            GROUP BY player_id
        )
        SELECT s.player_id, s.player_name, s.events_played, s.wins, s.top_10s,
               s.cuts, s.latest_event_date,
               sc.scoring_avg, sc.avg_to_par, sc.rounds_logged, sc.best_round,
               (SELECT min(finish_rank) FROM analytics.player_results pr
                 WHERE pr.player_id = s.player_id) AS best_finish
        FROM analytics.player_season_summary s
        LEFT JOIN scoring sc ON sc.player_id = s.player_id
        WHERE s.player_id = %(pid)s
        """,
        {"pid": player_id},
    )
    history = query(
        ROUND_GRAIN
        + """
        , agg AS (
            SELECT tournament_id,
                   sum(strokes) AS total_strokes,
                   jsonb_agg(jsonb_build_object('round', round_no, 'strokes', strokes,
                                                'toPar', score_to_par, 'course', course_name)
                             ORDER BY round_no) AS round_detail
            FROM rounds
            WHERE player_id = %(pid)s
            GROUP BY tournament_id
        )
        SELECT p.tournament_id, p.tournament_name, p.event_end_date,
               p.finish_position, p.finish_rank, p.score_to_par, p.score_text,
               p.player_status, p.rounds_played,
               a.total_strokes, a.round_detail
        FROM analytics.player_results p
        LEFT JOIN agg a ON a.tournament_id = p.tournament_id
        WHERE p.player_id = %(pid)s
        ORDER BY p.event_end_date
        """,
        {"pid": player_id},
    )
    return {"summary": summary, "history": history}


# --------------------------------------------------------------------------
# Scoring (round grain)
# --------------------------------------------------------------------------

def course_difficulty():
    return query(
        ROUND_GRAIN
        + """
        SELECT course_name,
               count(DISTINCT tournament_id)         AS events,
               count(*)                              AS rounds_logged,
               round(avg(score_to_par)::numeric, 3)  AS avg_to_par,
               round(avg(strokes)::numeric, 2)       AS avg_strokes,
               min(strokes)                          AS low_round
        FROM rounds
        GROUP BY course_name
        HAVING count(*) >= 50
        ORDER BY avg_to_par DESC
        """
    )


def round_profile():
    by_round = query(
        ROUND_GRAIN
        + """
        SELECT round_no,
               count(*)                              AS rounds_logged,
               round(avg(strokes)::numeric, 2)       AS avg_strokes,
               round(avg(score_to_par)::numeric, 3)  AS avg_to_par
        FROM rounds
        WHERE round_no BETWEEN 1 AND 4
        GROUP BY round_no
        ORDER BY round_no
        """
    )
    distribution = query(
        ROUND_GRAIN
        + """
        SELECT score_to_par, count(*) AS rounds_logged
        FROM rounds
        WHERE score_to_par BETWEEN -12 AND 12
        GROUP BY score_to_par
        ORDER BY score_to_par
        """
    )
    low_rounds = query(
        ROUND_GRAIN
        + """
        SELECT player_name, tournament_name, course_name, round_no, strokes, score_to_par
        FROM rounds
        ORDER BY score_to_par, strokes
        LIMIT 15
        """
    )
    return {"by_round": by_round, "distribution": distribution, "low_rounds": low_rounds}


# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------

def pipeline_health():
    checkpoints = query(
        """
        SELECT b.org_id, b.season_year, b.tournament_id, b.tournament_name,
               b.status, b.row_count, b.source_run_id, b.updated_at, b.error,
               (SELECT count(*) FROM analytics.player_results p
                 WHERE p.tournament_id = b.tournament_id
                   AND p.season_year = b.season_year) AS player_rows,
               (SELECT count(*) FROM analytics.team_results t
                 WHERE t.tournament_id = b.tournament_id
                   AND t.season_year = b.season_year) AS team_rows
        FROM ops.slash_golf_backfill b
        ORDER BY b.updated_at DESC, b.tournament_id
        """
    )
    runs = query(
        """
        SELECT source_run_id,
               count(*)          AS raw_rows,
               min(ingested_at)  AS started,
               max(ingested_at)  AS finished
        FROM raw.slash_golf_results
        GROUP BY source_run_id
        ORDER BY min(ingested_at) DESC
        """
    )
    quality = query(
        """
        SELECT 'Player results missing a finish rank'            AS check_name,
               count(*) FILTER (WHERE finish_rank IS NULL)       AS flagged,
               count(*)                                          AS total,
               'expected -- CUT/WD/DQ have no numeric rank'      AS note
        FROM analytics.player_results
        UNION ALL
        SELECT 'Player results missing a score to par',
               count(*) FILTER (WHERE score_to_par IS NULL),
               count(*),
               'expected -- withdrawn/disqualified players keep raw text'
        FROM analytics.player_results
        UNION ALL
        SELECT 'Player results with zero rounds recorded',
               count(*) FILTER (WHERE rounds_played = 0),
               count(*),
               'withdrawals before the first tee shot'
        FROM analytics.player_results
        UNION ALL
        SELECT 'Raw records excluded from analytics',
               (SELECT count(*) FROM raw.slash_golf_results r
                 WHERE NOT EXISTS (SELECT 1 FROM analytics.completed_results c
                                    WHERE c.raw_id = r.id)),
               (SELECT count(*) FROM raw.slash_golf_results),
               '2024 demo load + learning snapshots, kept but not published'
        UNION ALL
        SELECT 'Checkpoints not marked complete',
               count(*) FILTER (WHERE status <> 'complete'),
               count(*),
               'failed or deferred tournaments block the transform'
        FROM ops.slash_golf_backfill
        UNION ALL
        SELECT 'Duplicate player rows per event',
               (SELECT count(*) FROM (
                   SELECT 1 FROM analytics.player_results
                   GROUP BY org_id, season_year, tournament_id, player_id
                   HAVING count(*) > 1) d),
               (SELECT count(*) FROM analytics.player_results),
               'primary key makes this structurally impossible'
        """
    )
    coverage = query(
        """
        WITH scheduled AS (
            SELECT s.org_id,
                   s.season_year,
                   e ->> 'tournId'  AS tournament_id,
                   e ->> 'name'     AS tournament_name,
                   e ->> 'format'   AS format,
                   (to_timestamp(((e #>> '{date,end,$date,$numberLong}')::numeric) / 1000)
                      AT TIME ZONE 'UTC')::date        AS event_end_date,
                   (e #>> '{purse,$numberInt}')::bigint AS purse
            FROM raw.slash_golf_schedules s,
                 LATERAL jsonb_array_elements(s.payload -> 'schedule') e
        )
        SELECT sc.season_year,
               sc.tournament_id,
               sc.tournament_name,
               sc.format,
               sc.event_end_date,
               sc.purse,
               (b.tournament_id IS NOT NULL) AS loaded,
               b.row_count
        FROM scheduled sc
        LEFT JOIN ops.slash_golf_backfill b
               ON b.tournament_id = sc.tournament_id
              AND b.season_year   = sc.season_year
              AND b.org_id        = sc.org_id
              AND b.status        = 'complete'
        ORDER BY sc.event_end_date
        """
    )
    return {
        "checkpoints": checkpoints,
        "runs": runs,
        "quality": quality,
        "coverage": coverage,
    }
