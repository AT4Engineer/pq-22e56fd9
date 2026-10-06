#!/usr/bin/env python3
"""Write data/history.csv from data/history.json (one row per trading day) for Google Sheets IMPORTDATA."""
import csv, json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
hist = json.load(open(os.path.join(ROOT, "data", "history.json")))
with open(os.path.join(ROOT, "data", "history.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Date", "Total", "Day change", "Day change %", "SPCX", "UPRO", "Option liability", "Cash"])
    for h in hist:
        p = h.get("positions", {})
        w.writerow([h["date"], h.get("total"), h.get("day_change"), h.get("day_change_pct"),
                    p.get("SPCX", {}).get("value"), p.get("UPRO", {}).get("value"),
                    h.get("option_liability"), h.get("cash")])
