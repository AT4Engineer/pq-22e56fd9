#!/usr/bin/env python3
"""Write data/roll.csv from data/portfolio.json for Google Sheets IMPORTDATA.

Key/value rows (key, value, note) for the monthly covered-call roll, e.g.
  =VLOOKUP("buyback_ask", IMPORTDATA(".../data/roll.csv"), 2, FALSE)
Money values are dollars for the whole position (1 contract = 100 shares). Blank = not available.
"""
import csv, json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = json.load(open(os.path.join(ROOT, "data", "portfolio.json")))
roll = p.get("roll") or {}
c, n, h = roll.get("current") or {}, roll.get("next") or {}, roll.get("history") or {}
v = lambda x: "" if x is None else x
rows = [
    ("current_contract", v(c.get("label")), "open short call"),
    ("current_mark", v(c.get("mark")), "per share"),
    ("current_bid", v(c.get("bid")), "per share"),
    ("current_ask", v(c.get("ask")), "per share"),
    ("buyback_ask", v(c.get("buyback_ask")), "cost to buy to close now at the ask (realistic fill)"),
    ("buyback_mid", v(c.get("buyback_mid")), "cost to buy to close now at the mid"),
    ("premium_received", v(c.get("premium_received")), "premium originally received (blank = not set)"),
    ("pl_if_closed", v(c.get("pl_if_closed_ask")), "premium received minus buyback at the ask"),
    ("deadline", v(c.get("deadline_text")), ""),
    ("next_expiry", v(n.get("expiry")), "next monthly expiry"),
    ("next_atm_strike", v(n.get("atm_strike")), "strike nearest the share price"),
    ("next_bid", v(n.get("bid")), "per share"),
    ("next_ask", v(n.get("ask")), "per share"),
    ("next_mid", v(n.get("mid")), "per share"),
    ("est_premium", v(n.get("est_premium")), "new premium at the bid (conservative)"),
    ("net_roll", v(n.get("net_roll")), "new premium (bid) minus buyback (ask); negative = debit"),
    ("premium_pct", v(n.get("premium_pct")), "premium as % of share value"),
    ("annualized_pct", v(n.get("annualized_pct")), "premium %, annualized"),
    ("breakeven", v(n.get("breakeven")), "share price minus new premium"),
    ("premium_income_net", v(h.get("net_total")), "all premiums received minus buybacks (recorded)"),
    ("as_of_et", v(p.get("generated_at_et")), ""),
]
with open(os.path.join(ROOT, "data", "roll.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["key", "value", "note"])
    w.writerows(rows)
