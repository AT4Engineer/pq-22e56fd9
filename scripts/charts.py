"""Price-chart helpers for build_data.py: data/charts/<SYMBOL>.json, sparklines, account chart.

Chart file format (all times are epoch seconds; values rounded to 2-4 decimals):
  {"symbol", "kind": "stock"|"option"|"account", "generated_at_iso", "ranges": {
     "1D":  {"interval": "5m",  "t": [...], "v": [...], "base": prev_close, "session_open": ts, "session_close": ts},
     "1W":  {"interval": "30m", "t": [...], "v": [...], "base": first value},
     "1M" / "3M" / "1Y" / "ALL": {"interval": "1d" (ALL may be thinned), "t": [...], "v": [...], "base": ...}}}
A range that has no data is simply left out. Nothing is made up: missing data means a missing range.
"""
import json
import math
import os
import re
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ALL_MAX_POINTS = 900


def safe_name(symbol):
    return re.sub(r"[^A-Za-z0-9.\-]", "_", symbol.upper())


def _num(x):
    try:
        x = float(x)
        return None if math.isnan(x) or math.isinf(x) else x
    except (TypeError, ValueError):
        return None


def _rd(x, nd=4):
    return None if x is None else round(x, nd if abs(x) < 10 else 2)


def session_bounds(day):
    o = datetime.combine(day, time(9, 30), ET)
    c = datetime.combine(day, time(16, 0), ET)
    return int(o.timestamp()), int(c.timestamp())


def fetch_series(symbol):
    """Return (intraday, daily): lists of (datetime ET, close). intraday = 5m bars of the last 5 sessions,
    regular hours only; daily = full daily history. Raises on total failure."""
    import yfinance as yf

    t = yf.Ticker(symbol)
    intraday, daily = [], []
    try:
        h = t.history(period="5d", interval="5m", prepost=False, auto_adjust=False)
        for ts, row in h.iterrows():
            v = _num(row.get("Close"))
            if v is not None:
                d = ts.tz_convert(ET).to_pydatetime()
                if time(9, 30) <= d.time() < time(16, 0):
                    intraday.append((d, v))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] {symbol}: intraday chart fetch failed ({e})")
    try:
        h = t.history(period="max", interval="1d", auto_adjust=False)
        for ts, row in h.iterrows():
            v = _num(row.get("Close"))
            if v is not None:
                daily.append((ts.tz_convert(ET).to_pydatetime() if ts.tzinfo else ts.to_pydatetime().replace(tzinfo=ET), v))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] {symbol}: daily chart fetch failed ({e})")
    if not intraday and not daily:
        raise RuntimeError(f"no chart data for {symbol}")
    return intraday, daily


def resample(points, minutes):
    """Bucket (dt, v) points into N-minute bars (last value of each bucket, labelled with bucket start)."""
    out = {}
    for d, v in points:
        m = (d.hour * 60 + d.minute) // minutes * minutes
        key = d.replace(hour=m // 60, minute=m % 60, second=0, microsecond=0)
        out[key] = v
    return sorted(out.items())


def _daily_ts(d):
    return int(datetime.combine(d.date(), time(16, 0), ET).timestamp())


def _rng(points, ts_fn, base=None, interval="1d", nd=4):
    if not points:
        return None
    t = [ts_fn(d) for d, _ in points]
    v = [_rd(x, nd) for _, x in points]
    return {"interval": interval, "t": t, "v": v, "base": _rd(base if base is not None else points[0][1], nd)}


def last_session(intraday):
    if not intraday:
        return None, []
    day = intraday[-1][0].date()
    return day, [(d, v) for d, v in intraday if d.date() == day]


def daily_ranges(daily, today_price=None, today=None):
    """1M / 3M / 1Y / ALL from daily closes. Optionally replace/append today's close with the live price."""
    pts = list(daily)
    if today_price is not None and today is not None:
        if pts and pts[-1][0].date() == today:
            pts[-1] = (pts[-1][0], today_price)
        elif not pts or pts[-1][0].date() < today:
            pts.append((datetime.combine(today, time(16, 0), ET), today_price))
    if not pts:
        return {}
    end = pts[-1][0]
    out = {}
    for name, days in (("1M", 31), ("3M", 92), ("1Y", 366)):
        cut = end - timedelta(days=days)
        sel = [p for p in pts if p[0] >= cut]
        prior = [p for p in pts if p[0] < cut]
        r = _rng(sel, _daily_ts, base=prior[-1][1] if prior else sel[0][1])
        if r:
            out[name] = r
    allp = pts
    interval = "1d"
    if len(allp) > ALL_MAX_POINTS:
        step = math.ceil(len(allp) / ALL_MAX_POINTS)
        allp = allp[::-1][::step][::-1]
        if allp[-1] is not pts[-1]:
            allp.append(pts[-1])
        interval = f"{step}d"
    r = _rng(allp, _daily_ts, base=pts[0][1], interval=interval)
    if r:
        out["ALL"] = r
    return out


def stock_chart(symbol, intraday, daily, prev_close, live_price=None, trade_date=None):
    """Return (chart dict, spark list [[minute offset from 9:30, close], ...])."""
    ranges = {}
    day, sess = last_session(intraday)
    spark = []
    if sess:
        so, sc = session_bounds(day)
        # 1D base: the close of the session before `day` (prev_close only applies if `day` is the quote's session)
        base = prev_close
        if trade_date and day.isoformat() != trade_date:
            before = [v for d, v in daily if d.date() < day]
            base = before[-1] if before else sess[0][1]
        r = _rng(sess, lambda d: int(d.timestamp()), base=base, interval="5m")
        r["session_open"], r["session_close"] = so, sc
        r["session_date"] = day.isoformat()
        ranges["1D"] = r
        spark = [[(d.hour * 60 + d.minute) - 570, _rd(v)] for d, v in sess]
        wk = resample(intraday, 30)
        r = _rng(wk, lambda d: int(d.timestamp()), interval="30m")
        if r:
            ranges["1W"] = r
    td = datetime.fromisoformat(trade_date).date() if trade_date else None
    ranges.update(daily_ranges(daily, live_price, td))
    return {"symbol": symbol, "kind": "stock", "ranges": ranges}, spark, (ranges.get("1D") or {}).get("base")


def option_chart(contract, label, recorded, daily, prev_mark, mark, trade_date):
    """recorded: [(dt, mark)] from data/intraday.json (this tracker's own ~15-min marks)."""
    ranges = {}
    spark = []
    if recorded:
        day = recorded[-1][0].date()
        sess = [(d, v) for d, v in recorded if d.date() == day]
        so, sc = session_bounds(day)
        r = _rng(sess, lambda d: int(d.timestamp()), base=prev_mark, interval="15m")
        r["session_open"], r["session_close"] = so, sc
        r["session_date"] = day.isoformat()
        ranges["1D"] = r
        spark = [[(d.hour * 60 + d.minute) - 570, _rd(v)] for d, v in sess]
        r = _rng(recorded, lambda d: int(d.timestamp()), interval="15m")
        if r and len(recorded) > len(sess):
            ranges["1W"] = r
    td = datetime.fromisoformat(trade_date).date() if trade_date else None
    dr = daily_ranges(daily, mark, td)
    for k in ("1M", "3M", "ALL"):
        if k in dr:
            ranges[k] = dr[k]
    if "ALL" in dr:
        ranges["1Y"] = dr["ALL"]
    return {"symbol": contract, "label": label, "kind": "option", "ranges": ranges,
            "note": "Option prices: daily = last trade of each day (thin trading); intraday = marks recorded by this tracker."}, spark


def write_if_changed(path, obj, stamp_iso):
    old = None
    try:
        with open(path) as f:
            old = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if old is not None:
        o = dict(old); o.pop("generated_at_iso", None)
        if o == obj:
            return False
    out = dict(obj); out["generated_at_iso"] = stamp_iso
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)
    return True
