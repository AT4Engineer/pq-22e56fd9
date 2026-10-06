#!/usr/bin/env python3
"""Write data/current.csv from data/portfolio.json for Google Sheets IMPORTDATA.

One row per holding (stocks, options, cash) plus a TOTAL row:
  symbol, price, source, market_value, as_of_et
Options use the OCC contract symbol (e.g. UPRO261016C00154000); price is the per-share mark and
market_value is the signed position value (negative for a short).
"""
import csv, json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = json.load(open(os.path.join(ROOT, "data", "portfolio.json")))
gen = p.get("generated_at_et")
acct = p.get("account", {})
rows = []
for s in p.get("positions", []):
    rows.append([s["symbol"], s.get("price"), s.get("price_source") or "quote",
                 s.get("value"), s.get("quote_time_et") or p.get("quotes_as_of_et") or gen])
for o in p.get("options", []):
    rows.append([o.get("contract") or o.get("label"), o.get("mark"), o.get("mark_source") or "mark",
                 o.get("liability"), o.get("quote_as_of_et") or gen])
rows.append(["CASH", 1, "holdings.json", acct.get("cash"), gen])
rows.append(["TOTAL", "", "account total (stocks + cash + option liability)", acct.get("total"), gen])
with open(os.path.join(ROOT, "data", "current.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["symbol", "price", "source", "market_value", "as_of_et"])
    w.writerows(rows)
