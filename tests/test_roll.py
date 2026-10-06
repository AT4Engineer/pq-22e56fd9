"""Tests for the covered-call roll plan: set_option_premium, roll (two linked records), roll history."""
import json
import os
import sys
import unittest
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
sys.path.insert(0, HERE)
from trade_logic import TradeError, apply_transaction  # noqa: E402
import apply_trade  # noqa: E402
import roll_plan  # noqa: E402
from test_apply_trade import TODAY, TestCiFlow, base  # noqa: E402

OCT = {"right": "call", "strike": 154, "expiry": "2026-10-16"}
NOV = {"right": "call", "strike": 156, "expiry": "2026-11-20"}


def roll_txn(**kw):
    t = {"type": "roll", "symbol": "UPRO", "qty": 1, "fees": 0.65, "date": "2026-10-16",
         "close": {"option": OCT, "price": 5.80}, "open": {"option": NOV, "price": 7.00}}
    t.update(kw)
    return t


class TestPremium(unittest.TestCase):
    def test_set_premium_per_share(self):
        H, rec = apply_transaction(base(), {"type": "set_option_premium", "symbol": "UPRO", "option": OCT, "price": 3.8},
                                   today=TODAY)
        self.assertEqual(H["options"][0]["open_price"], 3.8)
        self.assertEqual(H["cash"], 964.7)  # premium is already in cash
        self.assertEqual(rec["premium_total"], 380.0)
        self.assertIn("Set premium received UPRO Oct 16 2026 $154 call = $3.80/share ($380.00)", rec["description"])

    def test_set_premium_total_and_inferred_contract(self):
        H, _ = apply_transaction(base(), {"type": "premium received", "amount": 412}, today=TODAY)
        self.assertEqual(H["options"][0]["open_price"], 4.12)

    def test_set_premium_needs_open_option(self):
        H = base()
        H["options"] = []
        with self.assertRaises(TradeError):
            apply_transaction(H, {"type": "set_option_premium", "price": 3}, today=TODAY)
        with self.assertRaises(TradeError):
            apply_transaction(base(), {"type": "set_option_premium", "price": 0}, today=TODAY)

    def test_premium_feeds_buy_to_close_realized(self):
        H, _ = apply_transaction(base(), {"type": "set_option_premium", "price": 3.8}, today=TODAY)
        _, rec = apply_transaction(H, {"type": "buy_to_close", "qty": 1, "price": 5.8, "option": OCT}, today=TODAY)
        self.assertEqual(rec["realized_pl"], -200.0)


class TestRoll(unittest.TestCase):
    def test_roll_credit(self):
        H, rec = apply_transaction(base(), roll_txn(), today=date(2026, 10, 16))
        self.assertEqual([(o["strike"], o["expiry"], o["open_price"]) for o in H["options"]], [(156, "2026-11-20", 7.0)])
        self.assertEqual(H["cash"], round(964.7 - 580 - 0.65 + 700 - 0.65, 2))
        self.assertEqual(rec["net_credit"], 118.7)
        self.assertEqual([l["type"] for l in rec["legs"]], ["buy_to_close", "sell_to_open"])
        self.assertIn("Roll 1 UPRO Oct 16 2026 $154 call -> Nov 20 2026 $156 call (net credit $118.70)", rec["description"])

    def test_roll_debit_allowed_when_cash_ends_positive(self):
        H = base()
        H["cash"] = 100
        # buyback (1200) is more than cash, but the new premium brings cash back above zero
        H2, rec = apply_transaction(H, roll_txn(close={"option": OCT, "price": 12.0}, open={"option": NOV, "price": 11.5}, fees=0),
                                    today=date(2026, 10, 16))
        self.assertEqual((H2["cash"], rec["net_credit"]), (50.0, -50.0))
        H["cash"] = 10
        with self.assertRaisesRegex(TradeError, "Not enough cash"):
            apply_transaction(H, roll_txn(close={"option": OCT, "price": 12.0}, open={"option": NOV, "price": 11.5}, fees=0),
                              today=date(2026, 10, 16))

    def test_roll_infers_close_contract_and_right(self):
        H, rec = apply_transaction(base(), roll_txn(close={"price": 5.8}, open={"option": {"strike": 156, "expiry": "2026-11-20"},
                                                                              "price": 7}), today=date(2026, 10, 16))
        self.assertEqual(rec["legs"][1]["option"]["right"], "call")

    def test_roll_errors(self):
        with self.assertRaises(TradeError):
            apply_transaction(base(), roll_txn(open={"option": OCT, "price": 7}), today=TODAY)
        with self.assertRaises(TradeError):
            apply_transaction(base(), {"type": "roll", "close": {"price": 5.8}}, today=TODAY)
        with self.assertRaises(TradeError):  # nothing open
            H = base()
            H["options"] = []
            apply_transaction(H, roll_txn(), today=TODAY)
        with self.assertRaises(TradeError):  # new call would be uncovered (2 contracts, 100 shares)
            apply_transaction(base(), roll_txn(open={"option": NOV, "price": 7, "qty": 2}), today=TODAY)

    def test_records_split_and_link(self):
        _, rec = apply_transaction(base(), roll_txn(), today=date(2026, 10, 16))
        recs = apply_trade.records(rec, "T12", {"issue": 12})
        self.assertEqual([r["id"] for r in recs], ["T12a", "T12b"])
        self.assertEqual({r["roll_id"] for r in recs}, {"R12"})
        self.assertEqual([r["type"] for r in recs], ["buy_to_close", "sell_to_open"])
        self.assertTrue(all(r["issue"] == 12 for r in recs))
        _, dep = apply_transaction(base(), {"type": "deposit", "amount": 5}, today=TODAY)
        self.assertEqual(len(apply_trade.records(dep, "T13", {})), 1)


class TestHistory(unittest.TestCase):
    def test_history_from_edit_transactions(self):
        H = base()
        txns = []
        H, r = apply_transaction(H, {"type": "set_option_premium", "price": 3.8}, today=TODAY)
        txns.append(r)
        H, r = apply_transaction(H, roll_txn(fees=0), today=date(2026, 10, 16))
        txns += apply_trade.records(r, "T20", {"issue": 20})
        h = roll_plan.history(txns, H)
        rows = h["rows"]
        self.assertEqual([x["label"] for x in rows], ["UPRO Oct 16 2026 $154 call", "UPRO Nov 20 2026 $156 call"])
        self.assertEqual((rows[0]["premium"], rows[0]["close_cost"], rows[0]["net"]), (380.0, 580.0, -200.0))
        self.assertEqual(rows[0]["rolled_to"], "UPRO Nov 20 2026 $156 call")
        self.assertEqual((rows[1]["premium"], rows[1]["open"], rows[1]["cumulative"]), (700.0, True, 500.0))
        self.assertEqual((h["premiums_total"], h["buybacks_total"], h["net_total"]), (1080.0, 580.0, 500.0))

    def test_plain_sell_to_open_and_buy_to_close_feed_history(self):
        H = base()
        H, r1 = apply_transaction(H, {"type": "buy_to_close", "qty": 1, "price": 5, "option": OCT, "date": "2026-10-16"},
                                  today=date(2026, 10, 16))
        H, r2 = apply_transaction(H, {"type": "sell_to_open", "symbol": "UPRO", "qty": 1, "price": 6.5, "option": NOV,
                                      "date": "2026-10-16"}, today=date(2026, 10, 16))
        h = roll_plan.history([r1, r2], H)
        self.assertEqual([(x["close_action"], x["premium"], x["close_cost"]) for x in h["rows"]],
                         [("Bought back", None, 500.0), ("Open", 650.0, None)])
        self.assertTrue(h["missing_premium"])


class TestPreview(unittest.TestCase):
    rows = [{"strike": k, "bid": b, "ask": a, "mid": (a + b) / 2 if b else None, "contract": f"C{k}"}
            for k, b, a in [(150, 10.7, 14.7), (154, 8.3, 11.2), (155, 7.6, 10.2), (156, 7.0, 10.9),
                            (157, 6.5, 10.4), (158, 6.0, 8.3), (160, 5.0, 7.3)]]

    def test_expiry_helpers(self):
        self.assertEqual(roll_plan.next_monthly_expiry(date(2026, 10, 16)), date(2026, 11, 20))
        self.assertEqual(roll_plan.next_monthly_expiry(date(2026, 12, 18)), date(2027, 1, 15))
        self.assertEqual(roll_plan.choose_expiry(["2026-11-20"], date(2026, 11, 20)), ("2026-11-20", None))
        self.assertEqual(roll_plan.choose_expiry(["2026-11-27"], date(2026, 11, 20))[0], "2026-11-27")

    def test_preview_numbers(self):
        p = roll_plan.preview(self.rows, 156.41, 1, 100, 580.0, "2026-11-20", date(2026, 10, 6))
        self.assertEqual(p["atm_strike"], 156)
        self.assertEqual([s["strike"] for s in p["strikes"]], [154, 155, 156, 157, 158])
        self.assertEqual((p["est_premium"], p["net_roll"], p["breakeven"], p["days"]), (700.0, 120.0, 149.41, 45))
        self.assertEqual(p["premium_pct"], 4.48)
        self.assertEqual(p["annualized_pct"], 36.3)

    def test_no_bid_is_not_invented(self):
        rows = [dict(r, bid=0.0, mid=None) for r in self.rows]
        p = roll_plan.preview(rows, 156.41, 1, 100, 580.0, "2026-11-20", date(2026, 10, 6))
        self.assertIsNone(p["est_premium"])
        self.assertIsNone(p["net_roll"])
        self.assertIn("can't be estimated", p["note"])

    def test_this_month(self):
        o = {"label": "UPRO Oct 16 2026 $154 call", "underlying": "UPRO", "strike": 154.0, "expiry": "2026-10-16",
             "contracts": 1, "multiplier": 100, "bid": 3.1, "ask": 5.8, "mark": 4.45}
        now = datetime(2026, 10, 6, 19, 0, tzinfo=roll_plan.ET)
        c = roll_plan.this_month(o, None, now)
        self.assertEqual((c["buyback_ask"], c["buyback_mid"], c["premium_received"], c["pl_if_closed_ask"]),
                         (580.0, 445.0, None, None))
        self.assertEqual(c["deadline_text"], "Buy to close before 4:00 PM ET Fri Oct 16 to keep your shares")
        c = roll_plan.this_month(o, 3.8, now)
        self.assertEqual((c["premium_received"], c["pl_if_closed_ask"], c["pl_if_closed_mid"]), (380.0, -200.0, -65.0))


class TestRollCi(TestCiFlow):
    def test_roll_issue_writes_two_linked_records_once(self):
        body = "```json\n" + json.dumps(roll_txn(date=TODAY.isoformat())) + "\n```"
        r = self.ci(self.event(30, body))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        tx = self.origin_file("data/transactions.json")
        self.assertEqual([(t["id"], t["type"], t["roll_id"]) for t in tx],
                         [("T30a", "buy_to_close", "R30"), ("T30b", "sell_to_open", "R30")])
        self.assertEqual(self.origin_file("data/holdings.json")["options"][0]["expiry"], "2026-11-20")
        self.assertIn("Net credit: $118.70", self.gh())
        self.ci(self.event(30, body))
        self.assertEqual(len(self.origin_file("data/transactions.json")), 2)


del TestCiFlow  # imported only as a base class; its own tests run from test_apply_trade

if __name__ == "__main__":
    unittest.main()
