"""Offline checks for parsing the PGA TOUR player directory page."""
import json
import unittest

from ingestion.ingest_pga_tour_players import parse_directory


def page(queries):
    data = {'props': {'pageProps': {'dehydratedState': {'queries': queries}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


class ParseDirectoryTests(unittest.TestCase):
    def test_returns_directory_players_only(self):
        html = page([
            {'queryKey': ['currentLeaders', {}], 'state': {'data': {'players': [{'id': '1', 'country': 'USA'}]}}},
            {'queryKey': ['playerDirectory', {'tourCode': 'R'}], 'state': {'data': {'players': [
                {'id': '46046', 'displayName': 'Scottie Scheffler', 'country': 'United States', 'countryFlag': 'USA'}]}}},
        ])
        self.assertEqual(parse_directory(html), [
            {'id': '46046', 'displayName': 'Scottie Scheffler', 'country': 'United States', 'countryFlag': 'USA'}])

    def test_layout_change_fails_loudly(self):
        with self.assertRaisesRegex(ValueError, 'no embedded data'):
            parse_directory('<html></html>')
        with self.assertRaisesRegex(ValueError, 'not found'):
            parse_directory(page([{'queryKey': ['featureFlags'], 'state': {'data': {}}}]))

    def test_missing_ids_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing player IDs'):
            parse_directory(page([{'queryKey': ['playerDirectory'], 'state': {'data': {'players': [{'country': 'USA'}]}}}]))


if __name__ == '__main__':
    unittest.main()
