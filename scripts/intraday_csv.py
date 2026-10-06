#!/usr/bin/env python3
"""Write data/intraday.csv from data/intraday.json (account value each minute, ET) for Google Sheets IMPORTDATA."""
import csv, json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try:
    d = json.load(open(os.path.join(ROOT, "data", "intraday.json")))
except (FileNotFoundError, json.JSONDecodeError):
    d = {"rows": []}
with open(os.path.join(ROOT, "data", "intraday.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Time (ET)", "Total", "Stocks", "Cash", "Option liability"])
    for r in d.get("rows", []):
        w.writerow([r[0][:16].replace("T", " ")] + list(r[1:5]))
