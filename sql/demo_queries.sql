-- Season leaders, only individual stroke-play results in completed backfills.
SELECT player_name, events_played, wins, top_10s, cuts
FROM analytics.player_season_summary
WHERE season_year = '2026'
ORDER BY wins DESC, top_10s DESC, player_name
LIMIT 15;

-- Latest completed tournament winners.
SELECT event_end_date, tournament_name, player_name, score_to_par
FROM analytics.player_results
WHERE finish_rank = 1
ORDER BY event_end_date DESC
LIMIT 10;

-- Team scores remain explicitly team scores.
SELECT tournament_name, players, finish_position, score_to_par
FROM analytics.team_results WHERE finish_position = '1';
