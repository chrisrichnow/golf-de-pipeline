-- Each query returns a violation count; all must be zero.
SELECT 'checkpoint_counts' AS check_name, count(*) AS violations
FROM (
 SELECT b.org_id, b.season_year, b.tournament_id
 FROM ops.slash_golf_backfill b
 LEFT JOIN analytics.completed_results r ON r.source_run_id = b.source_run_id
 WHERE b.status = 'complete'
 GROUP BY b.org_id, b.season_year, b.tournament_id, b.row_count
 HAVING count(r.raw_id) <> b.row_count
) mismatches
UNION ALL
SELECT 'unclassified_raw_rows', count(*) FROM analytics.completed_results
WHERE (payload ? 'player') = (payload ? 'team')
UNION ALL
SELECT 'player_count', abs(
 (SELECT count(*) FROM analytics.completed_results WHERE payload ? 'player') -
 (SELECT count(*) FROM analytics.player_results))
UNION ALL
SELECT 'team_count', abs(
 (SELECT count(*) FROM analytics.completed_results WHERE payload ? 'team') -
 (SELECT count(*) FROM analytics.team_results))
UNION ALL
SELECT 'missing_player_identity', count(*) FROM analytics.player_results
WHERE trim(player_name) = '' OR trim(player_id) = ''
UNION ALL
SELECT 'unexpected_score_format', count(*) FROM (
 SELECT score_text, score_to_par FROM analytics.player_results
 UNION ALL SELECT score_text, score_to_par FROM analytics.team_results
) scores
WHERE score_to_par IS NULL AND score_text IS NOT NULL
 AND upper(trim(score_text)) NOT IN ('', '-', '--', 'WD', 'DQ', 'DNS', 'CUT')
UNION ALL
SELECT 'no_completed_events', CASE WHEN EXISTS (
 SELECT 1 FROM ops.slash_golf_backfill WHERE status = 'complete'
) THEN 0 ELSE 1 END;
