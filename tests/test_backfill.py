import unittest
from datetime import date
from unittest.mock import patch, Mock

from ingestion.backfill_slash_golf import API, StopBackfill, candidates, event_end_date
from ingestion.ingest_slash_golf import prepare_records


class BackfillTests(unittest.TestCase):
    def test_team_score_is_not_mislabeled_as_player_score(self):
        expected = {'orgId': '1', 'year': '2026', 'tournId': '018'}
        team = {'teamId': '00119', 'total': '-31', 'players': [{'playerId': '1'}, {'playerId': '2'}]}
        data = dict(expected, leaderboardRows=[team])
        with self.assertRaises(ValueError):
            prepare_records(data, expected)
        records = prepare_records(data, expected, allow_teams=True)
        self.assertEqual(records[0]['team'], team)
        self.assertNotIn('player', records[0])

    def test_extended_json_schedule_date(self):
        event = {'date': {'end': {'$date': {'$numberLong': '1768694400000'}}}}
        self.assertEqual(event_end_date(event), date(2026, 1, 18))

    def test_future_and_current_day_excluded_and_ids_preserved(self):
        events = [
            {'tournId': '020', 'date': {'end': '2026-03-29T00:00:00'}},
            {'tournId': '006', 'date': {'end': '2026-01-18T00:00:00'}},
            {'tournId': '500', 'date': {'end': '2026-09-07T00:00:00'}},
            {'tournId': '999', 'date': {'end': '2026-12-01T00:00:00'}},
        ]
        self.assertEqual([e['tournId'] for e in candidates(events, date(2026, 9, 7))], ['006', '020'])

    def test_wrong_event_rejected_and_extended_json_preserved(self):
        expected = {'orgId': '1', 'year': '2026', 'tournId': '020'}
        data = dict(expected, roundId={'$numberInt': '3'}, leaderboardRows=[{'playerId': '123', 'total': 'E'}])
        records = prepare_records(data, expected)
        self.assertEqual(records[0]['tournament']['roundId'], {'$numberInt': '3'})
        self.assertEqual(records[0]['player']['total'], 'E')
        data['year'] = '2024'
        with self.assertRaises(ValueError):
            prepare_records(data, expected)

    @patch.dict('os.environ', {'SLASH_GOLF_API_KEY': 'test-placeholder'})
    @patch('ingestion.backfill_slash_golf.requests.get')
    def test_budget_stops_before_extra_request(self, get):
        get.return_value = Mock(status_code=200, headers={}, json=lambda: {})
        api = API(1)
        api.get('schedule', {})
        with self.assertRaises(StopBackfill):
            api.get('leaderboard', {})
        self.assertEqual(get.call_count, 1)

    @patch.dict('os.environ', {'SLASH_GOLF_API_KEY': 'test-placeholder'})
    @patch('ingestion.backfill_slash_golf.requests.get')
    def test_quota_response_stops_without_retry(self, get):
        get.return_value = Mock(status_code=429, headers={})
        with self.assertRaises(StopBackfill):
            API(60).get('schedule', {})
        self.assertEqual(get.call_count, 1)


if __name__ == '__main__':
    unittest.main()
