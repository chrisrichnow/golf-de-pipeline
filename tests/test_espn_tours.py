"""Offline checks for ESPN leaderboard validation."""
import unittest

from ingestion.ingest_espn_tours import validate


def leaderboard(status='STATUS_FINAL', competitions=None):
    competitors = [{'athlete': {'id': '3470', 'displayName': 'Rory McIlroy'}}]
    return {'events': [{'id': '1', 'name': 'Test Open', 'status': {'type': {'name': status}},
                        'competitions': competitions if competitions is not None else [{'competitors': competitors}]}]}


class ValidateTests(unittest.TestCase):
    def test_final_stroke_play_event_returns_competitors(self):
        event, competitors = validate(leaderboard(), '1')
        self.assertEqual(event['name'], 'Test Open')
        self.assertEqual(competitors[0]['athlete']['id'], '3470')

    def test_unfinished_event_is_deferred(self):
        self.assertIsNone(validate(leaderboard('STATUS_IN_PROGRESS'), '1')[1])

    def test_match_play_sessions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'not a single stroke-play'):
            validate(leaderboard(competitions=[[{'competitors': []}], [{'competitors': []}]]), '1')

    def test_team_entries_without_athletes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing an athlete ID'):
            validate(leaderboard(competitions=[{'competitors': [{'team': {'id': '9'}}]}]), '1')

    def test_wrong_event_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'requested event'):
            validate(leaderboard(), '2')


if __name__ == '__main__':
    unittest.main()
