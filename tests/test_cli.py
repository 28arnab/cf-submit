import importlib.util
import unittest
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parent.parent / "cli" / "main.py"
spec = importlib.util.spec_from_file_location("cf_main", CLI_PATH)
cf_main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf_main)


class TestParseTarget(unittest.TestCase):
    def test_contest_url(self):
        url = "https://codeforces.com" + "/contest/2164/problem/A"
        self.assertEqual(cf_main.parse_target([url]), ("2164", "A", False))

    def test_problemset_url(self):
        url = "https://codeforces.com" + "/problemset/problem/1950/C1"
        self.assertEqual(cf_main.parse_target([url]), ("1950", "C1", False))

    def test_gym_url(self):
        url = "https://codeforces.com" + "/gym/104500/problem/B"
        self.assertEqual(cf_main.parse_target([url]), ("104500", "B", True))

    def test_legacy_args(self):
        self.assertEqual(cf_main.parse_target(["2164", "a"]), ("2164", "A", False))

    def test_invalid_target(self):
        self.assertEqual(
            cf_main.parse_target(["https://example.com"]), (None, None, False)
        )


if __name__ == "__main__":
    unittest.main()
