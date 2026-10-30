#!/usr/bin/env python3
"""Write data/floor.json: real (delayed) quotes for the Trading Floor tab.

Source: Yahoo Finance via yfinance (free, unofficial, ~15 min delayed). For each symbol:
last price (regular session; after the close it is the official day close), previous close,
change, % change, open/high/low, volume, and the session's 5-minute closes as a sparkline.
On any fetch failure the last good file is kept (exit 0 with a warning), so the main data job
never fails because of this tab.
"""
import json
import math
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "floor.json")
ET = ZoneInfo("America/New_York")

SYMBOLS = [
    ("SPY", "S&P 500 ETF"), ("VOO", "Vanguard S&P 500"), ("VTI", "Total Market"), ("QQQ", "Nasdaq-100"),
    ("DIA", "Dow 30"), ("IWM", "Russell 2000"), ("UPRO", "3x S&P 500"), ("SPCX", "SpaceX"),
    ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "NVIDIA"), ("AMZN", "Amazon"),
    ("GOOGL", "Alphabet"), ("META", "Meta"), ("TSLA", "Tesla"), ("AVGO", "Broadcom"),
    ("AMD", "AMD"), ("NFLX", "Netflix"), ("JPM", "JPMorgan"), ("XOM", "Exxon"),
    ("XLK", "Tech sector"), ("XLF", "Financials"), ("XLE", "Energy"), ("^VIX", "VIX"),
]


def num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def build_rows(daily, intra, symbols=SYMBOLS):
    """daily: {sym: [(date_str, open, high, low, close, volume), ...]} oldest first.
    intra: {sym: [(epoch_s, close), ...]} regular-session 5m bars, oldest first.
    Returns rows; a symbol without two valid daily closes is skipped (never guessed)."""
    rows = []
    for sym, name in symbols:
        d = [r for r in daily.get(sym, []) if num(r[4]) is not None]
        if len(d) < 2:
            continue
        last, prev = d[-1], d[-2]
        price, pc = round(num(last[4]), 2), round(num(prev[4]), 2)
        bars = [(t, round(num(c), 2)) for t, c in intra.get(sym, []) if num(c) is not None]
        day0 = datetime.strptime(last[0], "%Y-%m-%d").date()
        bars = [b for b in bars if datetime.fromtimestamp(b[0], ET).date() == day0]
        chg = round(price - pc, 2)
        rows.append({
            "sym": sym.lstrip("^"), "name": name, "price": price, "prev_close": pc, "change": chg,
            "change_pct": round(chg / pc * 100, 2) if pc else None,
            "open": num(last[1]) and round(num(last[1]), 2), "high": num(last[2]) and round(num(last[2]), 2),
            "low": num(last[3]) and round(num(last[3]), 2), "volume": int(num(last[5]) or 0),
            "session_date": last[0], "spark": [c for _, c in bars], "bars": [[t, c] for t, c in bars[-12:]],
            "last_bar_epoch": bars[-1][0] if bars else None,
        })
    return rows


def fetch():
    import yfinance as yf
    tick = [s for s, _ in SYMBOLS]
    dd = yf.download(tick, period="10d", interval="1d", group_by="ticker", progress=False, auto_adjust=False, threads=True)
    di = yf.download(tick, period="2d", interval="5m", group_by="ticker", progress=False, auto_adjust=False, prepost=False, threads=True)
    daily, intra = {}, {}
    for s in tick:
        try:
            f = dd[s].dropna(subset=["Close"])
            daily[s] = [(i.strftime("%Y-%m-%d"), r["Open"], r["High"], r["Low"], r["Close"], r["Volume"]) for i, r in f.iterrows()]
        except Exception:
            pass
        try:
            f = di[s].dropna(subset=["Close"])
            intra[s] = [(int(i.timestamp()), r["Close"]) for i, r in f.iterrows()]
        except Exception:
            pass
    return daily, intra


def main():
    try:
        daily, intra = fetch()
        rows = build_rows(daily, intra)
        if len(rows) < len(SYMBOLS) // 2:
            raise RuntimeError(f"only {len(rows)} symbols came back")
    except Exception as ex:
        print(f"[warn] floor_data: {ex}; keeping the last data/floor.json", file=sys.stderr)
        return 0
    now = datetime.now(ET)
    last = max((r["last_bar_epoch"] or 0) for r in rows)
    out = {"source": "Yahoo Finance via yfinance (delayed ~15 min)",
           "generated_at_et": now.strftime("%Y-%m-%d %H:%M ET"), "generated_epoch": int(now.timestamp()),
           "as_of_epoch": min(last + 300, int(now.timestamp())) if last else None,  # bar close = start + 5 min, capped at now
           "session_date": rows[0]["session_date"], "symbols": rows}
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT)
    print(f"wrote data/floor.json: {len(rows)} symbols, session {out['session_date']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
