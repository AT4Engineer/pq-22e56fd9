import os, sys, unittest
from datetime import datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import floor_data as F

ET = ZoneInfo("America/New_York")
def ep(s): return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=ET).timestamp())

class FloorData(unittest.TestCase):
    def test_real_change_from_daily_closes(self):
        daily = {"UPRO": [("2026-10-29", 150, 151, 148, 149.35, 1e6), ("2026-10-30", 147, 148, 139, 140.12, 2e6)]}
        intra = {"UPRO": [(ep("2026-10-29 15:55"), 149.3), (ep("2026-10-30 09:30"), 146.0), (ep("2026-10-30 09:35"), 145.5)]}
        r = F.build_rows(daily, intra, [("UPRO", "3x")])[0]
        self.assertEqual((r["price"], r["prev_close"], r["change"]), (140.12, 149.35, -9.23))
        self.assertAlmostEqual(r["change_pct"], -6.18, places=2)
        self.assertEqual(r["spark"], [146.0, 145.5])  # only the latest session's bars
        self.assertEqual(r["last_bar_epoch"], ep("2026-10-30 09:35"))

    def test_missing_or_short_history_is_skipped_not_guessed(self):
        daily = {"A": [("2026-10-30", 1, 1, 1, 10, 1)], "B": [("2026-10-29", 1, 1, 1, float("nan"), 1), ("2026-10-30", 1, 1, 1, 5, 1)]}
        self.assertEqual(F.build_rows(daily, {}, [("A", ""), ("B", ""), ("C", "")]), [])

    def test_vix_caret_stripped(self):
        daily = {"^VIX": [("2026-10-29", 0, 0, 0, 17.2, 0), ("2026-10-30", 0, 0, 0, 21.17, 0)]}
        self.assertEqual(F.build_rows(daily, {}, [("^VIX", "VIX")])[0]["sym"], "VIX")

if __name__ == "__main__":
    unittest.main()
