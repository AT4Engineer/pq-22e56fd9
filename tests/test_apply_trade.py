"""Unit-style tests for the portfolio edit flow. Never touches the real data/holdings.json.

Run: python -m unittest discover -s tests -v
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from trade_logic import TradeError, apply_transaction, describe, normalize, summarize  # noqa: E402
import apply_trade  # noqa: E402

TODAY = date(2026, 10, 6)


def base():
    """Same shape as the real holdings (4 SPCX, 100 UPRO, short 1 UPRO Oct 16 2026 154 call, $964.70)."""
    return {
        "as_of": "2026-10-05", "cash": 964.7,
        "stocks": [{"symbol": "SPCX", "shares": 4, "exchange": "Nasdaq", "display_name": "SpaceX"},
                   {"symbol": "UPRO", "shares": 100, "exchange": "NYSE Arca", "display_name": "ProShares UltraPro S&P 500 (3x)"}],
        "options": [{"underlying": "UPRO", "type": "call", "position": "short", "contracts": 1, "multiplier": 100,
                     "strike": 154.0, "expiry": "2026-10-16"}],
        "watchlist": ["SPY"], "settings": {"use_extended_hours_price": False},
    }


def ap(H, **t):
    return apply_transaction(H, t, today=TODAY)


def stock(H, sym):
    return next((s for s in H["stocks"] if s["symbol"] == sym), None)


OPT = {"right": "call", "strike": 154, "expiry": "2026-10-16"}


class TestTypes(unittest.TestCase):
    def test_buy_existing_without_cost_basis(self):
        H0 = base()
        H, r = ap(H0, type="buy", symbol="UPRO", qty=10, price=50, fees=1)
        self.assertEqual(stock(H, "UPRO")["shares"], 110)
        self.assertNotIn("avg_cost", stock(H, "UPRO"))  # unknown basis stays unknown
        self.assertAlmostEqual(H["cash"], 964.7 - 501)
        self.assertEqual(r["cash_before"], 964.7)
        self.assertEqual(r["description"], "Buy 10 UPRO @ $50.00")
        self.assertEqual(H0, base(), "input must not be mutated")

    def test_buy_new_symbol_sets_avg_cost_with_fees(self):
        H, _ = ap(base(), type="buy", symbol="qqq", qty=1, price=500, fees=0.5)
        s = stock(H, "QQQ")
        self.assertEqual(s["shares"], 1)
        self.assertAlmostEqual(s["avg_cost"], 500.5)
        self.assertAlmostEqual(H["cash"], 464.2)

    def test_buy_weighted_average(self):
        H = base(); stock(H, "SPCX")["avg_cost"] = 150.0
        H, _ = ap(H, type="buy", symbol="SPCX", qty=4, price=170)
        self.assertEqual(stock(H, "SPCX")["shares"], 8)
        self.assertAlmostEqual(stock(H, "SPCX")["avg_cost"], 160.0)

    def test_buy_fractional(self):
        H, _ = ap(base(), type="buy", symbol="SPCX", qty="0.5", price="170")
        self.assertEqual(stock(H, "SPCX")["shares"], 4.5)

    def test_buy_insufficient_cash(self):
        with self.assertRaisesRegex(TradeError, "Not enough cash"):
            ap(base(), type="buy", symbol="UPRO", qty=10, price=150)

    def test_sell_partial_realized(self):
        H = base(); stock(H, "SPCX")["avg_cost"] = 150.0
        H, r = ap(H, type="sell", symbol="SPCX", qty=2, price=175, fees=0.1)
        self.assertEqual(stock(H, "SPCX")["shares"], 2)
        self.assertAlmostEqual(stock(H, "SPCX")["avg_cost"], 150.0)
        self.assertAlmostEqual(H["cash"], 964.7 + 350 - 0.1)
        self.assertAlmostEqual(r["realized_pl"], 49.9)

    def test_sell_all_removes_position(self):
        H, r = ap(base(), type="sell", symbol="SPCX", qty=4, price=175)
        self.assertIsNone(stock(H, "SPCX"))
        self.assertNotIn("realized_pl", r)  # no basis known

    def test_sell_more_than_held(self):
        with self.assertRaisesRegex(TradeError, "only 4 held"):
            ap(base(), type="sell", symbol="SPCX", qty=5, price=175)

    def test_sell_not_held(self):
        with self.assertRaisesRegex(TradeError, "don't hold"):
            ap(base(), type="sell", symbol="TSLA", qty=1, price=1)

    def test_sell_would_uncover_call(self):
        with self.assertRaisesRegex(TradeError, "covered"):
            ap(base(), type="sell", symbol="UPRO", qty=1, price=150)

    def test_sell_to_open_new_contract(self):
        H, _ = ap(base(), type="buy_to_close", symbol="UPRO", qty=1, price=5.0, option=OPT)
        H, r = ap(H, type="sell_to_open", symbol="UPRO", qty=1, price=3.25, fees=0.65,
                  option={"right": "call", "strike": 160, "expiry": "2026-11-20"})
        self.assertEqual(len(H["options"]), 1)
        o = H["options"][0]
        self.assertEqual((o["strike"], o["expiry"], o["position"], o["contracts"], o["open_price"]), (160, "2026-11-20", "short", 1, 3.25))
        self.assertAlmostEqual(H["cash"], 964.7 - 500 + 325 - 0.65)
        self.assertIn("Sell to open 1 UPRO Nov 20 2026 $160 call @ $3.25", r["description"])

    def test_sell_to_open_uncovered_call_rejected(self):
        with self.assertRaisesRegex(TradeError, "Uncovered call"):
            ap(base(), type="sell_to_open", symbol="UPRO", qty=1, price=3, option={"right": "call", "strike": 160, "expiry": "2026-11-20"})

    def test_sell_to_open_put_allowed(self):
        H, _ = ap(base(), type="sell_to_open", symbol="SPCX", qty=1, price=2, option={"right": "put", "strike": 150, "expiry": "2026-10-16"})
        self.assertEqual(H["options"][-1]["type"], "put")
        self.assertAlmostEqual(H["cash"], 1164.7)

    def test_sell_to_open_missing_fields(self):
        with self.assertRaisesRegex(TradeError, "strike"):
            ap(base(), type="sell_to_open", symbol="UPRO", qty=1, price=3, option={"right": "call", "expiry": "2026-11-20"})
        with self.assertRaisesRegex(TradeError, "whole number"):
            ap(base(), type="sell_to_open", symbol="UPRO", qty=1.5, price=3, option=OPT)

    def test_buy_to_close(self):
        H = base(); H["options"][0]["open_price"] = 2.0
        H, r = ap(H, type="buy_to_close", symbol="UPRO", qty=1, price=5.0, fees=0.65, option=OPT)
        self.assertEqual(H["options"], [])
        self.assertAlmostEqual(H["cash"], 964.7 - 500.65)
        self.assertAlmostEqual(r["realized_pl"], -300.65)

    def test_buy_to_close_unmatched(self):
        with self.assertRaisesRegex(TradeError, "No open option"):
            ap(base(), type="buy_to_close", symbol="UPRO", qty=1, price=5, option={"right": "call", "strike": 150, "expiry": "2026-10-16"})

    def test_option_expired(self):
        H, r = apply_transaction(base(), {"type": "option_expired", "symbol": "UPRO", "option": OPT, "date": "2026-10-16"}, today=date(2026, 10, 17))
        self.assertEqual(H["options"], [])
        self.assertEqual(H["cash"], 964.7)
        self.assertEqual(r["qty"], 1)

    def test_option_expired_before_expiry_rejected(self):
        with self.assertRaisesRegex(TradeError, "expires 2026-10-16"):
            ap(base(), type="option_expired", symbol="UPRO", option=OPT)

    def test_option_assigned_covered_call(self):
        H, r = apply_transaction(base(), {"type": "option_assigned", "symbol": "UPRO", "qty": 1, "option": OPT, "date": "2026-10-16"}, today=date(2026, 10, 17))
        self.assertIsNone(stock(H, "UPRO"), "100 shares removed -> position gone")
        self.assertEqual(H["options"], [])
        self.assertAlmostEqual(H["cash"], 964.7 + 15400)
        self.assertEqual(r["price"], 154.0)

    def test_option_assigned_infers_contract(self):
        H, _ = ap(base(), type="option_assigned", symbol="UPRO")
        self.assertAlmostEqual(H["cash"], 16364.7)

    def test_option_assigned_put(self):
        H, _ = ap(base(), type="deposit", amount=20000)
        H, _ = ap(H, type="sell_to_open", symbol="SPCX", qty=1, price=2, option={"right": "put", "strike": 150, "expiry": "2026-10-16"})
        H, _ = ap(H, type="option_assigned", symbol="SPCX", option={"right": "put", "strike": 150, "expiry": "2026-10-16"})
        self.assertEqual(stock(H, "SPCX")["shares"], 104)
        self.assertAlmostEqual(H["cash"], 964.7 + 20000 + 200 - 15000)

    def test_deposit_withdraw_dividend_set_cash(self):
        H, _ = ap(base(), type="deposit", amount=100)
        self.assertAlmostEqual(H["cash"], 1064.7)
        H, _ = ap(H, type="withdraw", amount="64.70")
        self.assertAlmostEqual(H["cash"], 1000)
        H, r = ap(H, type="dividend", symbol="UPRO", amount=12.34)
        self.assertAlmostEqual(H["cash"], 1012.34)
        self.assertEqual(r["description"], "Dividend $12.34 from UPRO")
        H, _ = ap(H, type="set_cash", amount=0)
        self.assertEqual(H["cash"], 0)
        with self.assertRaisesRegex(TradeError, "Not enough cash"):
            ap(H, type="withdraw", amount=1)
        with self.assertRaisesRegex(TradeError, "greater than 0"):
            ap(H, type="deposit", amount=-5)

    def test_set_cost_basis(self):
        H, _ = ap(base(), type="set_cost_basis", symbol="UPRO", price=120.5)
        self.assertEqual(stock(H, "UPRO")["avg_cost"], 120.5)

    def test_watchlist_add_remove(self):
        H, r = ap(base(), type="watchlist_add", symbol="qqq")
        self.assertEqual(H["watchlist"], ["SPY", "QQQ"])
        self.assertEqual(H["as_of"], "2026-10-05")
        with self.assertRaisesRegex(TradeError, "already"):
            ap(H, type="watchlist_add", symbol="QQQ")
        H, _ = ap(H, type="watchlist_remove", symbol="QQQ")
        self.assertEqual(H, base())
        with self.assertRaisesRegex(TradeError, "not on the watchlist"):
            ap(H, type="watchlist_remove", symbol="QQQ")
        H, _ = ap(H, type="watchlist_add", symbol="^GSPC")
        self.assertIn("^GSPC", H["watchlist"])

    def test_bad_inputs(self):
        for t, msg in [({"type": "yolo"}, "Unknown type"), ({"type": "buy", "symbol": "UPRO", "qty": "ten", "price": 1}, "number"),
                       ({"type": "buy", "symbol": "UP RO!", "qty": 1, "price": 1}, "ticker"),
                       ({"type": "buy", "qty": 1, "price": 1}, "symbol"), ({"type": "buy", "symbol": "UPRO", "qty": 1}, "price"),
                       ({"type": "deposit", "amount": 5, "date": "2030-01-01"}, "future"),
                       ({"type": "deposit", "amount": 5, "fees": -1}, "negative"), ("not a dict", "object")]:
            with self.subTest(t=t), self.assertRaisesRegex(TradeError, msg):
                apply_transaction(base(), t, today=TODAY)

    def test_aliases_and_labels(self):
        self.assertEqual(normalize({"type": "Sell to open option", "symbol": "upro", "qty": 1, "price": 1, "option": OPT}, TODAY)["type"], "sell_to_open")
        self.assertEqual(normalize({"type": "Option assigned"}, TODAY)["type"], "option_assigned")
        self.assertEqual(normalize({"type": "watchlist-add", "symbol": "qqq"}, TODAY)["symbol"], "QQQ")

    def test_check_callback_used(self):
        def check(kind, t):
            raise TradeError(f"unknown {t['symbol']}")
        with self.assertRaisesRegex(TradeError, "unknown ZZZZ"):
            apply_transaction(base(), {"type": "watchlist_add", "symbol": "ZZZZ"}, today=TODAY, check=check)

    def test_summarize_and_describe(self):
        s = summarize(base())
        self.assertEqual(s["Cash"], "$964.70")
        self.assertIn("UPRO Oct 16 2026 $154 call", s)
        self.assertEqual(describe(normalize({"type": "set_cash", "amount": 1}, TODAY)), "Set cash to $1.00")


class TestIssueParsing(unittest.TestCase):
    def test_fenced_json(self):
        body = "<!-- note -->\nTap submit.\n\n```json\n{\"type\": \"deposit\", \"amount\": 5}\n```\n"
        self.assertEqual(apply_trade.parse_body(body), {"type": "deposit", "amount": 5})

    def test_bare_json_and_errors(self):
        self.assertEqual(apply_trade.parse_body('{"type":"set_cash","amount":1}')["type"], "set_cash")
        with self.assertRaisesRegex(TradeError, "Could not read"):
            apply_trade.parse_body("```json\n{oops}\n```")
        with self.assertRaisesRegex(TradeError, "one JSON object"):
            apply_trade.parse_body("```json\n[1,2]\n```")


class TestCiFlow(unittest.TestCase):
    """Runs the real CI entry point against a throwaway git repo + bare 'origin' with a fake `gh`."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, "origin.git")
        self.work = os.path.join(self.tmp, "work")
        run = lambda *c, cwd=None: subprocess.run(c, cwd=cwd, check=True, capture_output=True, text=True)
        run("git", "init", "-q", "--bare", "-b", "main", self.origin)
        os.makedirs(os.path.join(self.work, "data"))
        shutil.copytree(os.path.join(ROOT, "scripts"), os.path.join(self.work, "scripts"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        with open(os.path.join(self.work, "data", "holdings.json"), "w") as f:
            json.dump(base(), f, indent=2)
        with open(os.path.join(self.work, "data", "transactions.json"), "w") as f:
            f.write("[]\n")
        os.makedirs(os.path.join(self.work, "dist"))
        run("git", "init", "-q", "-b", "main", cwd=self.work)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", ".", cwd=self.work)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", cwd=self.work)
        run("git", "remote", "add", "origin", self.origin, cwd=self.work)
        run("git", "push", "-q", "origin", "main", cwd=self.work)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.ghlog = os.path.join(self.tmp, "gh.log")
        with open(os.path.join(self.bin, "gh"), "w") as f:
            f.write(f'#!/bin/sh\nprintf "%s\\n" "$*" >> {self.ghlog}\nprintf "\\n----\\n" >> {self.ghlog}\n')
        os.chmod(os.path.join(self.bin, "gh"), 0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def event(self, num, body, author="AT4Engineer"):
        p = os.path.join(self.tmp, f"ev{num}.json")
        with open(p, "w") as f:
            json.dump({"action": "opened", "issue": {"number": num, "body": body, "user": {"login": author},
                                                     "html_url": f"https://example/{num}", "labels": [{"name": "trade"}]}}, f)
        return p

    def ci(self, ev):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], APPLY_TRADE_SKIP_BUILD="1",
                   GITHUB_REPOSITORY="o/r", GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t")
        return subprocess.run([sys.executable, os.path.join(self.work, "scripts", "apply_trade.py"), "--event", ev],
                              cwd=self.work, env=env, capture_output=True, text=True)

    def origin_file(self, rel):
        return json.loads(subprocess.run(["git", "--git-dir", self.origin, "show", f"main:{rel}"],
                                         check=True, capture_output=True, text=True).stdout)

    def gh(self):
        if not os.path.exists(self.ghlog):
            return ""
        with open(self.ghlog) as f:
            return f.read()

    def test_apply_comment_close_and_dedupe(self):
        body = "```json\n" + json.dumps({"type": "deposit", "amount": 35.3, "note": "test"}) + "\n```"
        r = self.ci(self.event(7, body))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.origin_file("data/holdings.json")["cash"], 1000.0)
        tx = self.origin_file("data/transactions.json")
        self.assertEqual((len(tx), tx[0]["issue"], tx[0]["type"], tx[0]["cash_after"]), (1, 7, "deposit", 1000.0))
        g = self.gh()
        self.assertIn("issue comment 7", g)
        self.assertIn("**Applied:** Deposit $35.30", g)
        self.assertIn("| Cash | $964.70 | $1,000.00 |", g)
        self.assertIn("issue close 7 -R o/r --reason completed", g)
        # duplicate event (opened + labeled) is a no-op
        r = self.ci(self.event(7, body))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(self.origin_file("data/transactions.json")), 1)
        self.assertEqual(self.gh().count("issue comment 7"), 1)

    def test_validation_error_leaves_holdings(self):
        r = self.ci(self.event(8, "```json\n" + json.dumps({"type": "sell", "symbol": "UPRO", "qty": 100, "price": 150}) + "\n```"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.origin_file("data/holdings.json"), base())
        self.assertEqual(self.origin_file("data/transactions.json"), [])
        self.assertIn("**Not applied.**", self.gh())
        self.assertIn("not planned", self.gh())

    def test_other_author_ignored(self):
        r = self.ci(self.event(9, '{"type":"set_cash","amount":1}', author="someone-else"))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(self.origin_file("data/holdings.json"), base())
        self.assertEqual(self.gh(), "")


if __name__ == "__main__":
    unittest.main()
