"""Opt-in integration tests against local analytics; test mutations roll back."""
import os
import unittest
from unittest.mock import patch
from datetime import date

from dotenv import load_dotenv
from pipeline import PROJECT_ROOT, check_quality, connect, transform


@unittest.skipUnless(os.getenv('GOLF_TEST_DATABASE') == '1', 'Set GOLF_TEST_DATABASE=1 for local DB checks')
class TransformTests(unittest.TestCase):
    def setUp(self):
        load_dotenv(PROJECT_ROOT / '.env')
        self.conn = connect()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def test_score_and_date_formats(self):
        self.cur.execute("""SELECT analytics.score_to_par('E'), analytics.score_to_par('+3'),
            analytics.score_to_par('-16'), analytics.score_to_par('WD'), analytics.score_to_par('-'),
            analytics.event_date('{"$date":{"$numberLong":"1768694400000"}}'::jsonb),
            analytics.event_date('"2026-01-18T00:00:00Z"'::jsonb)""")
        self.assertEqual(self.cur.fetchone(), (0, 3, -16, None, None, date(2026, 1, 18), date(2026, 1, 18)))

    def test_missing_result_fails_quality_check(self):
        self.cur.execute('DELETE FROM analytics.player_results WHERE raw_id = (SELECT min(raw_id) FROM analytics.player_results)')
        with self.assertRaisesRegex(ValueError, 'player_count'):
            check_quality(self.cur)

    def test_practice_snapshot_does_not_enter_analytics(self):
        self.cur.execute('SELECT count(*) FROM analytics.completed_results')
        before = self.cur.fetchone()[0]
        self.cur.execute("""INSERT INTO raw.slash_golf_results (source_run_id,payload)
            SELECT gen_random_uuid(),payload FROM analytics.completed_results LIMIT 1""")
        self.cur.execute('SELECT count(*) FROM analytics.completed_results')
        self.assertEqual(self.cur.fetchone()[0], before)

    def test_failed_rebuild_rolls_back(self):
        def fail_after_mutation(cur):
            cur.execute("UPDATE analytics.player_results SET player_name='ROLLBACK_TEST'")
            raise ValueError('Injected quality failure')

        self.cur.execute('SELECT count(*) FROM analytics.player_results')
        before = self.cur.fetchone()[0]
        with patch('pipeline.check_quality', side_effect=fail_after_mutation):
            with self.assertRaisesRegex(ValueError, 'Injected quality failure'):
                transform()
        self.cur.execute("SELECT count(*), count(*) FILTER (WHERE player_name='ROLLBACK_TEST') FROM analytics.player_results")
        self.assertEqual(self.cur.fetchone(), (before, 0))


if __name__ == '__main__':
    unittest.main()
