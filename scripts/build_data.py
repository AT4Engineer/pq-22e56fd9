#!/usr/bin/env python3
"""Build data/portfolio.json for the static dashboard.

Reads data/holdings.json, fetches quotes from Yahoo Finance via yfinance, values the
account (stocks + cash - short option liability), upserts one point per trading day into
data/history.json, attaches a small SPY paper-lab snapshot (data/paper.json), and writes data/portfolio.json.

Never fabricates prices: if a stock quote cannot be fetched the script exits non-zero and
leaves the existing files untouched.

Off-hours option quotes: overnight/weekends Yahoo often returns bid = ask = 0 for the option. Such a
run never degrades a good mark: the last good bid/ask mid (data/option_state.json, saved with its
session date and timestamp) is reused, the option's day change is taken against the prior session's
recorded mark (or the prior-close mark saved by the last good run of the same session), and a
session's history row is only replaced by a run whose quotes are at least as good (bid/ask present),
or when it is the first record for that session.

Usage:
  python scripts/build_data.py            # normal run
  python scripts/build_data.py --force    # rewrite even if market data did not change
Env:
  PAPER_LAB_DIR   path to the spy-paper-lab folder (default: ../spy-paper-lab next to the repo)
  SEED_HISTORY_CSV  optional tracker history.csv used only when data/history.json is missing
"""
import csv
import json
import math
import os
import re
import sys
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import charts  # noqa: E402

ET = ZoneInfo("America/New_York")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
D = lambda name: os.path.join(DATA, name)


# ---------------------------------------------------------------- helpers
def num(x):
    try:
        x = float(x)
        return None if math.isnan(x) or math.isinf(x) else x
    except (TypeError, ValueError):
        return None


def r2(x):
    return None if x is None else round(x, 2)


def r4(x):
    return None if x is None else round(x, 4)


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def et_str(dt, fmt="%Y-%m-%d %H:%M ET"):
    return dt.astimezone(ET).strftime(fmt) if dt else None


def warn(msg):
    print(f"[warn] {msg}", file=sys.stderr)


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


MARKET_LABELS = {
    "REGULAR": "Market open",
    "PRE": "Pre-market",
    "PREPRE": "Closed (overnight)",
    "POST": "After hours",
    "POSTPOST": "Closed (after hours)",
    "CLOSED": "Market closed",
}


# ---------------------------------------------------------------- quotes
def get_quote(symbol, use_ext):
    import yfinance as yf

    t = yf.Ticker(symbol)
    info = {}
    try:
        info = t.info or {}
    except Exception as e:
        warn(f"{symbol}: .info failed ({e}); trying fast_info/history")
    price = num(info.get("regularMarketPrice"))
    prev = num(info.get("regularMarketPreviousClose")) or num(info.get("previousClose"))
    qtime = info.get("regularMarketTime")
    if price is None or prev is None:
        try:
            fi = t.fast_info
            price = price or num(fi.get("lastPrice"))
            prev = prev or num(fi.get("regularMarketPreviousClose")) or num(fi.get("previousClose"))
        except Exception as e:
            warn(f"{symbol}: fast_info failed ({e})")
    if price is None or prev is None or not qtime:
        h = t.history(period="5d", auto_adjust=False)
        if h.empty:
            raise RuntimeError(f"No price data for {symbol}")
        price = price or float(h["Close"].iloc[-1])
        prev = prev or (float(h["Close"].iloc[-2]) if len(h) > 1 else None)
        qtime = qtime or int(h.index[-1].timestamp())
    if price is None:
        raise RuntimeError(f"No price for {symbol}")
    qdt = datetime.fromtimestamp(qtime, ET) if qtime else datetime.now(ET)
    state = info.get("marketState") or "UNKNOWN"
    ext_price, ext_label = None, ""
    if state in ("POST", "POSTPOST", "CLOSED") and num(info.get("postMarketPrice")):
        ext_price, ext_label = num(info.get("postMarketPrice")), "post-market"
    elif state in ("PRE", "PREPRE") and num(info.get("preMarketPrice")):
        ext_price, ext_label = num(info.get("preMarketPrice")), "pre-market"
    used, source = price, ("live regular session" if state == "REGULAR" else "regular-session close")
    if use_ext and ext_price is not None:
        used, source = ext_price, ext_label
    stats = {
        "open": num(info.get("regularMarketOpen")) or num(info.get("open")),
        "day_high": num(info.get("regularMarketDayHigh")) or num(info.get("dayHigh")),
        "day_low": num(info.get("regularMarketDayLow")) or num(info.get("dayLow")),
        "volume": num(info.get("regularMarketVolume")) or num(info.get("volume")),
        "avg_volume": num(info.get("averageVolume")),
        "high_52w": num(info.get("fiftyTwoWeekHigh")),
        "low_52w": num(info.get("fiftyTwoWeekLow")),
        "market_cap": num(info.get("marketCap")),
        "net_assets": num(info.get("totalAssets")),
        "quote_type": info.get("quoteType") or "",
    }
    return {
        "symbol": symbol,
        "stats": stats,
        "name": info.get("longName") or info.get("shortName") or symbol,
        "exchange": info.get("fullExchangeName") or info.get("exchange") or "",
        "price": used,
        "regular_price": price,
        "prev_close": prev,
        "quote_time": qdt,
        "market_state": state,
        "ext_price": ext_price,
        "ext_label": ext_label,
        "source": source,
    }


def get_option(opt, spot, now):
    """Mark = mid(bid/ask) if two-sided, else last trade, else intrinsic."""
    import yfinance as yf

    und, typ = opt["underlying"], opt["type"].lower()
    expiry, strike = opt["expiry"], float(opt["strike"])
    res = {"contract": None, "bid": None, "ask": None, "last": None, "mark": None,
           "mark_source": None, "chain_prev_close": None, "iv": None, "oi": None,
           "volume": None, "last_trade": None, "warnings": []}
    expired = date.fromisoformat(expiry) < now.date()
    if expired:
        res["warnings"].append("Option has expired - update data/holdings.json (assigned or expired worthless).")
    else:
        try:
            t = yf.Ticker(und)
            expiries = t.options
            if expiry not in expiries:
                res["warnings"].append(f"Expiry {expiry} not found in the {und} option chain.")
            else:
                chain = t.option_chain(expiry)
                df = chain.calls if typ == "call" else chain.puts
                row = df[(df["strike"] - strike).abs() < 1e-6]
                if row.empty:
                    res["warnings"].append(f"Strike {strike:g} not found for {und} {expiry} {typ}.")
                else:
                    row = row.iloc[0]
                    bid, ask, last = num(row["bid"]), num(row["ask"]), num(row["lastPrice"])
                    chg = num(row.get("change"))
                    lt = row.get("lastTradeDate")
                    res.update(contract=row["contractSymbol"], bid=bid, ask=ask, last=last,
                               iv=num(row.get("impliedVolatility")), oi=num(row.get("openInterest")),
                               volume=num(row.get("volume")),
                               last_trade=lt.tz_convert(ET).to_pydatetime() if lt is not None else None)
                    if bid and ask and bid > 0 and ask > 0 and ask >= bid:
                        res["mark"], res["mark_source"] = (bid + ask) / 2, "mid of bid/ask"
                    elif last:
                        res["mark"], res["mark_source"] = last, "last trade (no two-sided quote)"
                    if last is not None and chg is not None:
                        res["chain_prev_close"] = last - chg
        except Exception as e:
            res["warnings"].append(f"Option chain fetch failed ({e}).")
    intrinsic = max(0.0, spot - strike) if typ == "call" else max(0.0, strike - spot)
    if res["mark"] is None:
        res["mark"], res["mark_source"] = intrinsic, "intrinsic value (no quote available)"
        if not expired:
            res["warnings"].append("No option quote; liability uses intrinsic value only.")
    res["intrinsic"] = intrinsic
    res["expired"] = expired
    return res


def assignment_risk(itm, dist_pct, dte, extrinsic):
    """Plain heuristic for a short call. dist_pct = (spot - strike) / strike * 100."""
    if itm:
        if dte <= 2 or (extrinsic is not None and extrinsic < 0.10):
            return "VERY HIGH", "In the money with little time value left - assignment is likely (early assignment possible)."
        return "HIGH", "In the money - likely assigned at expiry if it stays above the strike."
    gap = -dist_pct  # how far below the strike, in %
    if gap <= 1.0:
        return "AT THE STRIKE", "Right at the strike - a small move up puts it in the money."
    if gap <= 3.0:
        return "ELEVATED", "Close to the strike - a normal UPRO day could push it above."
    if gap <= 7.0:
        return "MODERATE", "Some cushion below the strike, but UPRO moves 3x the S&P 500."
    return "LOW", "Well below the strike."


# ---------------------------------------------------------------- option quote quality / state
Q_BIDASK, Q_LAST, Q_INTRINSIC = 3, 2, 1
STATE_KEYS = ("mark", "bid", "ask", "last", "iv", "oi", "volume", "last_trade_et", "contract",
              "session", "prev_mark", "prev_mark_source")


def option_key(o):
    return f"{o['underlying']}|{o['expiry']}|{float(o['strike']):g}|{o['type'].lower()}"


def has_two_sided(oq):
    b, a = oq.get("bid"), oq.get("ask")
    return bool(b and a and b > 0 and a > 0 and a >= b)


def resolve_option_mark(oq, good, trade_date, prev_hist):
    """Pick the mark, its quality and the day-change basis for one option.

    Returns dict(mark, mark_source, quality, prev_mark, prev_mark_source, reused, quote) where quote
    holds the bid/ask/last/iv/... to display (live, or the reused last-good snapshot)."""
    hist_prev = None
    if prev_hist and num(prev_hist.get("option_mark")) is not None:
        hist_prev = (num(prev_hist["option_mark"]), f"recorded mark for prior session {prev_hist['date']}")
    live_q = {k: oq.get(k) for k in ("bid", "ask", "last", "iv", "oi", "volume", "contract")}
    live_q["last_trade_et"] = et_str(oq.get("last_trade"))
    if has_two_sided(oq):
        if hist_prev:
            pm, pms = hist_prev
        elif oq.get("chain_prev_close") is not None:
            pm, pms = oq["chain_prev_close"], "option's prior close (last - change)"
        else:
            pm, pms = None, None
        return dict(mark=oq["mark"], mark_source=oq["mark_source"], quality=Q_BIDASK, prev_mark=pm,
                    prev_mark_source=pms, reused=False, quote=live_q)
    if good and num(good.get("mark")) is not None and not oq.get("expired") and good.get("session", "") <= trade_date:
        same = good.get("session") == trade_date
        last_today = bool(oq.get("last") and oq.get("last_trade") and oq["last_trade"].date().isoformat() == trade_date)
        if same or not last_today:
            if hist_prev:
                pm, pms = hist_prev
            elif same and good.get("prev_mark") is not None:
                pm, pms = good["prev_mark"], good.get("prev_mark_source") or "prior-close mark saved with the last good quote"
            else:
                pm, pms = good["mark"], f"last good mark (session {good.get('session')}); no newer two-sided quote"
            q = {k: good.get(k) for k in ("bid", "ask", "last", "iv", "oi", "volume", "contract", "last_trade_et")}
            return dict(mark=good["mark"],
                        mark_source=f"last good bid/ask mid (session {good.get('session')}, saved {good.get('as_of_et')}); no live bid/ask now",
                        quality=Q_BIDASK if same else Q_LAST, prev_mark=pm, prev_mark_source=pms, reused=True,
                        quote_as_of_et=good.get("as_of_et"), good_session=good.get("session"), quote=q)
    # no good mark to fall back on: last trade or intrinsic (the original behaviour)
    quality = Q_LAST if (oq.get("mark_source") or "").startswith("last trade") else Q_INTRINSIC
    if hist_prev:
        pm, pms = hist_prev
    elif oq.get("chain_prev_close") is not None:
        pm, pms = oq["chain_prev_close"], "option's prior close (last - change)"
    else:
        pm, pms = None, None
    return dict(mark=oq["mark"], mark_source=oq["mark_source"], quality=quality, prev_mark=pm,
                prev_mark_source=pms, reused=False, quote=live_q)


# ---------------------------------------------------------------- history
def seed_history():
    """Used only if data/history.json does not exist yet."""
    path = os.environ.get("SEED_HISTORY_CSV") or os.path.join(os.path.dirname(ROOT), "portfolio", "history.csv")
    out = []
    if os.path.exists(path):
        with open(path, newline="") as f:
            for row in csv.DictReader(f):
                total = num(row.get("total"))
                if not row.get("date") or total is None:
                    continue
                pos = {k[:-6]: {"value": num(v)} for k, v in row.items() if k.endswith("_value")}
                out.append({"date": row["date"], "total": total,
                            "day_change": num(row.get("day_change_usd")),
                            "day_change_pct": num(row.get("day_change_pct")),
                            "cash": num(row.get("cash")), "option_liability": num(row.get("option_liability")),
                            "option_mark": num(row.get("option_mark")), "positions": pos,
                            "updated_et": row.get("updated_et")})
    return out


# ---------------------------------------------------------------- paper lab
def _fmt_current(c):
    if isinstance(c, dict):
        return ", ".join(f"{k.replace('_', ' ')}: {_fmt_current(v)}" for k, v in c.items())
    if isinstance(c, float):
        return f"{c:.3f}".rstrip("0").rstrip(".") if c != 0 else "0"
    if isinstance(c, bool):
        return "yes" if c else "no"
    return str(c)


def build_paper_snapshot(lab):
    ledger_p = os.path.join(lab, "state", "paper_ledger.csv")
    champ = load_json(os.path.join(lab, "state", "champion.json"))
    ready = load_json(os.path.join(lab, "state", "readiness.json"))
    if not (os.path.exists(ledger_p) and champ and ready):
        return None
    with open(ledger_p, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return None
    last = rows[-1]
    fwd = champ.get("forward", {})
    wf = champ.get("walk_forward", {})
    params = champ.get("params", {})

    def pos_label(p, trade_hint=""):
        p = num(p) or 0.0
        return "LONG SPY" if p >= 0.999 else ("CASH" if p <= 0.001 else f"{p * 100:.0f}% SPY")

    def nice_id():
        fam = champ.get("family", "")
        if fam == "trend_sma":
            freq = {"D": "daily", "W": "weekly", "M": "monthly"}.get(params.get("freq"), params.get("freq"))
            band = num(params.get("band")) or 0
            return f"Trend filter: SPY above its {params.get('n')}-day average ({freq} check" + (
                f", {band * 100:.1f}% band)" if band else ")")
        return champ.get("id")

    criteria = []
    for c in ready.get("criteria", []):
        prog = None
        m = re.search(r">=\s*(\d+)\s*trading days", c.get("threshold", ""))
        if m and isinstance(c.get("current"), (int, float)):
            prog = {"current": c["current"], "target": int(m.group(1)), "unit": "trading days"}
        criteria.append({"id": c.get("id"), "description": c.get("description"), "threshold": c.get("threshold"),
                         "current": _fmt_current(c.get("current")), "pass": bool(c.get("pass")), "progress": prog})
    target_next = num(last.get("champ_target_next"))
    bh_pos = num(last.get("bh_position")) or 0.0
    return {
        "simulation_only": True,
        "source": "spy-paper-lab (state/paper_ledger.csv, champion.json, readiness.json)",
        "data_through": last.get("date"),
        "start_date": fwd.get("start_date") or rows[0].get("date"),
        "forward_days": fwd.get("forward_days", max(0, len(rows) - 1)),
        "spy_close": num(last.get("spy_close")),
        "signal_change": last.get("signal_change") or "",
        "champion": {
            "id": champ.get("id"), "label": nice_id(),
            "equity": num(last.get("champ_equity")), "return": num(fwd.get("champ_return")),
            "drawdown_now": num(last.get("champ_drawdown")), "max_dd": num(fwd.get("champ_max_dd")),
            "position": pos_label(last.get("champ_position")),
            "target_next": None if target_next is None else pos_label(target_next),
            "trades": fwd.get("champ_trades"), "sharpe": num(fwd.get("champ_sharpe")),
            "installed": champ.get("installed_data_date"),
        },
        "buy_hold": {
            "label": "Buy-and-hold SPY", "equity": num(last.get("bh_equity")), "return": num(fwd.get("bh_return")),
            "drawdown_now": num(last.get("bh_drawdown")), "max_dd": num(fwd.get("bh_max_dd")),
            "position": pos_label(bh_pos) + ("" if bh_pos > 0.001 else " (enters next open)" if len(rows) == 1 else ""),
            "sharpe": num(fwd.get("bh_sharpe")),
        },
        "forward_note": fwd.get("note"),
        "walk_forward": {
            "windows_won": wf.get("windows_won"), "overfit_flag": wf.get("overfit_flag"),
            "oos_cagr": num(wf.get("oos", {}).get("cagr")), "oos_bh_cagr": num(wf.get("oos_bh", {}).get("cagr")),
            "oos_sharpe": num(wf.get("oos", {}).get("sharpe")), "oos_bh_sharpe": num(wf.get("oos_bh", {}).get("sharpe")),
            "oos_max_dd": num(wf.get("oos", {}).get("max_dd")), "oos_bh_max_dd": num(wf.get("oos_bh", {}).get("max_dd")),
            "oos_years": num(wf.get("oos", {}).get("years")),
        },
        "series": [{"date": r["date"], "champ": num(r.get("champ_equity")), "bh": num(r.get("bh_equity"))} for r in rows],
        "readiness": {
            "status": ready.get("status"),
            "passed": sum(1 for c in criteria if c["pass"]),
            "total": len(criteria),
            "criteria": criteria,
            "notes": ready.get("notes", [])[:3],
        },
    }


# ---------------------------------------------------------------- stocks list + charts
MARKS_KEEP_DAYS = 10
INTRADAY_KEEP_SESSIONS = 7
REFRESH_TAIL_MIN = 5  # recompute the last few stored minutes each run (the newest 1m bar may still be forming)


def _stats(st):
    return {k: (r2(v) if isinstance(v, float) and k not in ("volume", "avg_volume", "market_cap", "net_assets") else v)
            for k, v in (st or {}).items()}


def record_option_marks(now, regular, options):
    """Append this run's live bid/ask option marks to data/option_marks.json (regular session only)."""
    path = D("option_marks.json")
    data = load_json(path, {}) or {}
    pts = data.get("points", [])
    ts = int(now.timestamp())
    pts = [p for p in pts if p.get("t", 0) >= ts - MARKS_KEEP_DAYS * 86400]
    # keep the previous run's last good bid/ask mid too (option_state.json only holds the latest one)
    for key, v in (load_json(D("option_state.json"), {}) or {}).items():
        lg = (v or {}).get("last_good") or {}
        try:
            t0 = int(datetime.strptime(str(lg.get("as_of_et", ""))[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp())
        except ValueError:
            continue
        if num(lg.get("mark")) is not None and t0 >= ts - MARKS_KEEP_DAYS * 86400 and \
                not any(abs(p["t"] - t0) < 60 and key in p.get("marks", {}) for p in pts):
            pts.append({"t": t0, "et": et_str(datetime.fromtimestamp(t0, ET)), "marks": {key: num(lg["mark"])}})
    pts.sort(key=lambda p: p["t"])
    live = [o for o in options if not o.get("quote_reused") and o.get("quote_quality") == Q_BIDASK]
    if regular and live and time(9, 30) <= now.time() < time(16, 0) and (not pts or ts - pts[-1]["t"] >= 120):
        pts.append({"t": ts, "et": et_str(now), "marks": {o["key"]: o["mark"] for o in live}})
    new = {"note": "Option bid/ask mid marks recorded by build_data.py on each regular-session run.", "points": pts}
    if new != data:
        write_json(path, new)
    return pts


def _bars_1m(symbol):
    """{minute datetime ET: close} for regular-hours 1-minute bars (yfinance keeps ~7 days of 1m data)."""
    import yfinance as yf

    h = yf.Ticker(symbol).history(period="7d", interval="1m", prepost=False, auto_adjust=False)
    out = {}
    for ts, row in h.iterrows():
        v = num(row.get("Close"))
        if v is None:
            continue
        d = ts.tz_convert(ET).to_pydatetime().replace(second=0, microsecond=0)
        if time(9, 30) <= d.time() < time(16, 0):
            out[d] = v
    return out


def build_intraday(H, options, cash, marks_log, history, now):
    """Per-minute account value (current quantities x 1m closes + cash - option liability) -> data/intraday.json.

    Minutes already stored are kept as recorded (so a later trade doesn't rewrite the past); each run appends
    every minute since the last stored one (re-doing the newest few). Rolling 7 trading days.
    Returns (rows, option_method) where rows = [[iso_et, total, stocks, cash, option_liability], ...]."""
    path = D("intraday.json")
    old = load_json(path, {}) or {}
    rows = [r for r in old.get("rows", []) if isinstance(r, list) and len(r) >= 2]
    held = [s for s in H["stocks"]]
    bars = {}
    for s in held:
        b = _bars_1m(s["symbol"])
        if not b:
            raise RuntimeError(f"no 1m bars for {s['symbol']}")
        bars[s["symbol"]] = b

    # Option value per minute: one timeline of known prices for the contract, and each minute uses the latest
    # one at or before it: Yahoo 1m option trade prints (if any), bid/ask marks recorded by this tracker
    # (held constant between runs), the last good bid/ask mid in option_state.json, the recorded daily marks
    # in history.json, and Yahoo daily closes for older days. Falls back to the current mark.
    methods, timelines = [], {}
    state = load_json(D("option_state.json"), {}) or {}
    for o in options:
        tl, n_prints = [], 0
        if o.get("contract"):
            try:
                ob = _bars_1m(o["contract"])
                n_prints = len(ob)
                tl += [(d.timestamp(), v) for d, v in ob.items()]
            except Exception as e:  # noqa: BLE001
                warn(f"{o['contract']}: 1m option bars failed ({e})")
            try:
                import yfinance as yf
                h = yf.Ticker(o["contract"]).history(period="1mo", interval="1d", auto_adjust=False)
                tl += [(datetime.combine(ts.date(), time(16, 0), ET).timestamp() - 1, float(r["Close"]))
                       for ts, r in h.iterrows() if num(r.get("Close")) is not None]
            except Exception as e:  # noqa: BLE001
                warn(f"{o['contract']}: daily option bars failed ({e})")
        if len(options) == 1:
            tl += [(datetime.combine(date.fromisoformat(h["date"]), time(16, 0), ET).timestamp(), num(h["option_mark"]))
                   for h in history if num(h.get("option_mark")) is not None]
        lg = (state.get(o["key"]) or {}).get("last_good") or {}
        if num(lg.get("mark")) is not None and lg.get("as_of_et"):
            try:
                t0 = datetime.strptime(lg["as_of_et"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ET).timestamp()
                tl.append((t0, num(lg["mark"])))
            except ValueError:
                pass
        tl += [(p["t"], p["marks"][o["key"]]) for p in marks_log if o["key"] in p.get("marks", {})]
        timelines[o["key"]] = sorted(tl)
        methods.append(f"{o['label']}: each minute uses the latest known option price at or before that minute - "
                       f"a bid/ask mark recorded by this tracker (held constant between runs, ~15 min apart), or a "
                       f"Yahoo 1-minute trade print ({n_prints} in the last 7 days; the contract trades thinly), or "
                       f"the previous day's mark")

    def mark_at(o, d):
        ts = d.timestamp() + 59  # value at the end of the minute
        best = None
        for t, m in timelines.get(o["key"], []):
            if t > ts:
                break
            best = m
        return best if best is not None else o["mark"]

    minutes = sorted(set().union(*[set(b) for b in bars.values()]))
    computed, last, day = [], {}, None
    for d in minutes:
        if d.date() != day:
            day, last = d.date(), {}
        for sym, b in bars.items():
            if d in b:
                last[sym] = b[d]
        if len(last) < len(bars):
            continue
        stocks = sum(float(s["shares"]) * last[s["symbol"]] for s in held)
        opt = 0.0
        for o in options:
            sign = -1 if o["position"] == "short" else 1
            opt += sign * mark_at(o, d) * o["multiplier"] * o["contracts"]
        computed.append([d.isoformat(timespec="minutes"), r2(stocks + cash + opt), r2(stocks), r2(cash), r2(opt)])

    if rows:
        cutoff = (datetime.fromisoformat(rows[-1][0]) - timedelta(minutes=REFRESH_TAIL_MIN)).isoformat(timespec="minutes")
        keep = [r for r in rows if r[0] <= cutoff]
        known = {r[0] for r in keep}
        # keep stored minutes; add new minutes (and fill any gaps) from this run's reconstruction
        merged = {r[0]: r for r in keep}
        for r in computed:
            if r[0] > cutoff or r[0] not in known:
                merged[r[0]] = r
        rows = [merged[k] for k in sorted(merged)]
    else:
        rows = computed
    days = sorted({r[0][:10] for r in rows})[-INTRADAY_KEEP_SESSIONS:]
    rows = [r for r in rows if r[0][:10] >= days[0]] if days else []
    new = {"note": "Account value each minute of the regular session, ET. Stocks = quantity held at the time of the run "
                   "x 1-minute close; total = stocks + cash + option value (a short option is negative). "
                   "Rolling 7 trading days; filled in each time the update workflow runs (~every 15 min).",
           "option_mark_method": methods, "columns": ["time_et", "total", "stocks", "cash", "option_liability"],
           "rows": rows}
    if {k: v for k, v in new.items()} != old:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(new, f, separators=(",", ":"))
            f.write("\n")
        os.replace(tmp, path)
    return rows, methods


def account_chart(rows, methods, history, total, prev_total, trade_date):
    """1D: 1-minute values of the latest session; 1W: 5-minute values over the stored 7 sessions;
    1M and longer: the recorded daily account values."""
    ranges = {}
    if rows:
        pts = [(datetime.fromisoformat(r[0]), r[1]) for r in rows if r[1] is not None]
        day = pts[-1][0].date()
        one = [(d, v) for d, v in pts if d.date() == day]
        so, sc = charts.session_bounds(day)
        prior = [h for h in history if h["date"] < day.isoformat() and num(h.get("total")) is not None]
        base = prev_total if day.isoformat() == trade_date else (prior[-1]["total"] if prior else one[0][1])
        ranges["1D"] = {"interval": "1m", "t": [int(d.timestamp()) for d, _ in one], "v": [v for _, v in one],
                        "base": r2(base), "session_open": so, "session_close": sc, "session_date": day.isoformat()}
        wk = charts.resample(pts, 5)
        ranges["1W"] = {"interval": "5m", "t": [int(d.timestamp()) for d, _ in wk], "v": [v for _, v in wk],
                        "base": wk[0][1]}
    daily = [(datetime.combine(date.fromisoformat(h["date"]), time(16, 0), ET), h["total"])
             for h in history if num(h.get("total")) is not None]
    ranges.update(charts.daily_ranges(daily, total, date.fromisoformat(trade_date)))
    return {"symbol": "ACCOUNT", "kind": "account", "ranges": ranges,
            "note": "1D and 1W: minute-by-minute account value from data/intraday.json (quantities held at each update; "
                    "fills in every minute since the previous update each time the data refreshes, ~every 15 min). "
                    "1M and longer: the recorded daily account values." +
                    (" Option: " + "; ".join(methods) + "." if methods else "")}


def build_quotes_and_charts(H, quotes, wquotes, watch, positions, options, trade_date, now, history, total,
                            prev_total, cash, caveats):
    cdir = D("charts")
    os.makedirs(cdir, exist_ok=True)
    iso = now.isoformat(timespec="seconds")
    held = {p["symbol"]: p for p in positions}
    order = list(dict.fromkeys([p["symbol"] for p in positions] + [o["underlying"] for o in options] + watch))
    out, series, keep = {}, {}, {"_account.json"}
    for sym in order:
        q = quotes.get(sym) or wquotes.get(sym)
        if not q:
            continue
        p = held.get(sym)
        chg = q["price"] - q["prev_close"] if q["prev_close"] else None
        e = {"symbol": sym, "kind": "stock", "name": (p or {}).get("name") or q["name"], "long_name": q["name"],
             "exchange": (p or {}).get("exchange") or q["exchange"], "price": r2(q["price"]),
             "prev_close": r2(q["prev_close"]), "change": r2(chg),
             "change_pct": r2(chg / q["prev_close"] * 100) if chg is not None else None,
             "quote_time_et": et_str(q["quote_time"]), "market_state": q["market_state"],
             "stats": _stats(q.get("stats")), "held": p is not None, "watch": sym in watch,
             "chart": f"data/charts/{charts.safe_name(sym)}.json", "spark": [], "spark_base": r2(q["prev_close"])}
        try:
            intr, daily = charts.fetch_series(sym)
            ch, spark, base = charts.stock_chart(sym, intr, daily, q["prev_close"], q["price"], trade_date)
            ch["name"], ch["prev_close"] = e["name"], r2(q["prev_close"])
            charts.write_if_changed(os.path.join(cdir, charts.safe_name(sym) + ".json"), ch, iso)
            e["spark"], e["spark_base"] = spark, r2(base) if base is not None else e["spark_base"]
            series[sym] = intr
        except Exception as ex:  # noqa: BLE001
            warn(f"{sym}: chart failed ({ex})")
        if os.path.exists(os.path.join(cdir, charts.safe_name(sym) + ".json")):
            keep.add(charts.safe_name(sym) + ".json")
        else:
            e["chart"] = None
        out[sym] = e

    recorded_all = record_option_marks(now, any(q["market_state"] == "REGULAR" for q in quotes.values()), options)
    rows, methods = [], []
    try:
        rows, methods = build_intraday(H, options, cash, recorded_all, history, now)
    except Exception as ex:  # noqa: BLE001
        warn(f"intraday 1m account values failed ({ex}); keeping data/intraday.json as it was")
        old = load_json(D("intraday.json"), {}) or {}
        rows, methods = old.get("rows", []), old.get("option_mark_method", [])
    # per-minute option marks: derived from intraday.json's option_liability column (single option only;
    # the column is the summed value of all options), else the sparse marks recorded each run
    minute_marks = []
    if len(options) == 1 and rows:
        o0 = options[0]
        unit = (-1 if o0["position"] == "short" else 1) * o0["multiplier"] * o0["contracts"]
        minute_marks = [(datetime.fromisoformat(r[0]), round(r[4] / unit, 4)) for r in rows
                        if len(r) >= 5 and r[4] is not None and unit]
    for o in options:
        cid = o["contract"] or o["key"]
        rec = [(datetime.fromtimestamp(p["t"], ET), p["marks"][o["key"]]) for p in recorded_all
               if o["key"] in p.get("marks", {})]
        interval = "15m"
        if len(minute_marks) > len(rec):
            rec, interval = minute_marks, "1m"
        daily = []
        if o["contract"]:
            try:
                import yfinance as yf
                h = yf.Ticker(o["contract"]).history(period="max", interval="1d", auto_adjust=False)
                daily = [(ts.tz_convert(ET).to_pydatetime(), float(r["Close"])) for ts, r in h.iterrows()
                         if num(r.get("Close")) is not None]
            except Exception as ex:  # noqa: BLE001
                warn(f"{cid}: option daily history failed ({ex})")
        ch, spark = charts.option_chart(cid, o["label"], rec, daily, o["prev_mark"], o["mark"], trade_date, interval)
        fname = charts.safe_name(cid) + ".json"
        if ch["ranges"]:
            charts.write_if_changed(os.path.join(cdir, fname), ch, iso)
            keep.add(fname)
        chg = o["mark"] - o["prev_mark"] if o["prev_mark"] is not None else None
        t = "C" if o["type"] == "call" else "P"
        out[cid] = {"symbol": cid, "kind": "option", "display": f"{o['underlying']} {o['strike']:g}{t}",
                    "name": o["label"], "underlying": o["underlying"], "price": o["mark"], "prev_close": o["prev_mark"],
                    "change": r4(chg), "change_pct": r2(chg / o["prev_mark"] * 100) if chg is not None and o["prev_mark"] else None,
                    "held": True, "watch": False, "chart": f"data/charts/{fname}" if ch["ranges"] else None,
                    "spark": spark, "spark_base": o["prev_mark"], "key": o["key"]}
    try:
        ach = account_chart(rows, methods, history, total, prev_total, trade_date)
        charts.write_if_changed(os.path.join(cdir, "_account.json"), ach, iso)
    except Exception as ex:  # noqa: BLE001
        warn(f"account chart failed ({ex})")
    for f in os.listdir(cdir):
        if f.endswith(".json") and f not in keep:
            os.remove(os.path.join(cdir, f))
    return out


# ---------------------------------------------------------------- main
def strip_volatile(obj):
    o = json.loads(json.dumps(obj))
    o.pop("generated_at_et", None)
    o.pop("generated_at_iso", None)
    for h in o.get("history", []):
        h.pop("updated_et", None)
    return o


def main():
    force = "--force" in sys.argv
    H = load_json(D("holdings.json"))
    if not H:
        sys.exit("data/holdings.json missing or invalid")
    use_ext = bool(H.get("settings", {}).get("use_extended_hours_price", False))
    now = datetime.now(ET)
    stamp = et_str(now, "%Y-%m-%d %H:%M:%S ET")
    cash = float(H.get("cash", 0))
    caveats = []

    # 1) quotes (fail hard rather than guess)
    quotes = {}
    try:
        for s in H["stocks"]:
            quotes[s["symbol"]] = get_quote(s["symbol"], use_ext)
        for o in H.get("options", []):
            if o["underlying"] not in quotes:
                quotes[o["underlying"]] = get_quote(o["underlying"], use_ext)
    except Exception as e:
        print(f"[error] quote fetch failed: {e}. Leaving data files unchanged.", file=sys.stderr)
        sys.exit(1)

    # watchlist quotes are optional: a bad watchlist symbol never blocks the account update
    watch = []
    for w in H.get("watchlist", []) or []:
        w = str(w).strip().upper()
        if w and w not in watch:
            watch.append(w)
    wquotes = {}
    for w in watch:
        if w in quotes:
            continue
        try:
            wquotes[w] = get_quote(w, use_ext)
        except Exception as e:  # noqa: BLE001
            warn(f"watchlist {w}: quote failed ({e})")
            caveats.append(f"Watchlist {w}: no quote available right now.")

    trade_date = max(q["quote_time"] for q in quotes.values()).date().isoformat()
    history = load_json(D("history.json"))
    if history is None:
        history = seed_history()
    history = sorted([h for h in history if h.get("date")], key=lambda h: h["date"])
    prior = [h for h in history if h["date"] < trade_date]
    prev_hist = prior[-1] if prior else None

    # 2) stocks
    positions, stock_total, stock_day = [], 0.0, 0.0
    for s in H["stocks"]:
        q = quotes[s["symbol"]]
        qty = float(s["shares"])
        mv = qty * q["price"]
        unit = q["price"] - q["prev_close"] if q["prev_close"] else None
        dchg = qty * unit if unit is not None else None
        dpct = unit / q["prev_close"] * 100 if unit is not None else None
        stock_total += mv
        stock_day += dchg or 0
        avg = num(s.get("avg_cost"))
        cost = avg * qty if avg is not None else None
        unreal = mv - cost if cost is not None else None
        positions.append({
            "avg_cost": r4(avg), "cost_basis": r2(cost), "unrealized": r2(unreal),
            "unrealized_pct": r2(unreal / cost * 100) if cost else None,
            "symbol": s["symbol"], "name": s.get("display_name") or q["name"], "long_name": q["name"],
            "exchange": s.get("exchange") or q["exchange"], "shares": int(qty) if qty.is_integer() else qty,
            "price": r2(q["price"]), "prev_close": r2(q["prev_close"]), "day_change_per_share": r2(unit),
            "day_change": r2(dchg), "day_change_pct": r2(dpct), "value": r2(mv),
            "quote_time_et": et_str(q["quote_time"]), "market_state": q["market_state"], "price_source": q["source"],
            "ext_price": r2(q["ext_price"]), "ext_label": q["ext_label"],
        })

    # 3) options
    options, opt_total, opt_day = [], 0.0, 0.0
    state = load_json(D("option_state.json"), {}) or {}
    new_state = json.loads(json.dumps(state))
    qualities = []
    for o in H.get("options", []):
        spot = quotes[o["underlying"]]["price"]
        oq = get_option(o, spot, now)
        key = option_key(o)
        res = resolve_option_mark(oq, (state.get(key) or {}).get("last_good"), trade_date, prev_hist)
        qualities.append(res["quality"])
        oq["mark"], oq["mark_source"] = res["mark"], res["mark_source"]
        for k in ("bid", "ask", "last", "iv", "oi", "volume"):
            oq[k] = res["quote"].get(k)
        if res["reused"]:
            oq["warnings"] = [w for w in oq["warnings"] if not w.startswith("No option quote")]
        if res["quality"] == Q_BIDASK and not res["reused"]:
            snap = {"mark": r4(res["mark"]), "bid": oq["bid"], "ask": oq["ask"], "last": oq["last"], "iv": r4(oq["iv"]),
                    "oi": oq["oi"], "volume": oq["volume"], "last_trade_et": res["quote"].get("last_trade_et"),
                    "contract": oq["contract"], "session": trade_date, "prev_mark": r4(res["prev_mark"]),
                    "prev_mark_source": res["prev_mark_source"]}
            old = (state.get(key) or {}).get("last_good") or {}
            if any(old.get(k) != snap.get(k) for k in STATE_KEYS):  # avoid churn: only the timestamp would change
                snap["as_of_et"] = stamp
                new_state[key] = {"last_good": snap}
        n, mult = float(o["contracts"]), float(o.get("multiplier", 100))
        sign = -1 if o.get("position", "short") == "short" else 1
        value = sign * oq["mark"] * mult * n
        prev_mark, pm_src = res["prev_mark"], res["prev_mark_source"]
        dchg = sign * (oq["mark"] - prev_mark) * mult * n if prev_mark is not None else None
        opt_total += value
        opt_day += dchg or 0
        typ = o["type"].lower()
        strike = float(o["strike"])
        exp = date.fromisoformat(o["expiry"])
        exp_close = datetime.combine(exp, time(16, 0), ET)
        dte = (exp - now.date()).days
        itm = spot > strike if typ == "call" else spot < strike
        dist = spot - strike
        dist_pct = dist / strike * 100
        extrinsic = max(0.0, oq["mark"] - oq["intrinsic"])
        covered = typ == "call" and sign < 0 and any(
            s["symbol"] == o["underlying"] and float(s["shares"]) >= n * mult for s in H["stocks"])
        risk, risk_note = assignment_risk(itm, dist_pct, max(dte, 0), extrinsic) if (typ == "call" and sign < 0) else (None, None)
        # risk-neutral probability of finishing above the strike (Black-Scholes N(d2), r ~ 0); rough guide only
        p_itm = None
        T = (exp_close - now).total_seconds() / (365.0 * 86400)
        if oq["iv"] and oq["iv"] > 0.01 and T > 0:
            sig = oq["iv"]
            d2 = (math.log(spot / strike) - 0.5 * sig * sig * T) / (sig * math.sqrt(T))
            p_itm = norm_cdf(d2) if typ == "call" else 1 - norm_cdf(d2)
        spread = (oq["ask"] - oq["bid"]) if oq["bid"] and oq["ask"] else None
        label = f"{o['underlying']} {exp.strftime('%b %d %Y')} ${strike:g} {typ}"
        for w in oq["warnings"]:
            caveats.append(f"{label}: {w}")
        if res["reused"]:
            caveats.append(f"{label}: no live bid/ask right now (market closed or no quotes); using the last good "
                           f"bid/ask mid {res['mark']:.2f} from session {res.get('good_session')} "
                           f"(saved {res.get('quote_as_of_et')}).")
        if spread is not None and oq["mark"] and spread / oq["mark"] > 0.25:
            caveats.append(f"{label}: wide bid/ask ({oq['bid']:.2f} x {oq['ask']:.2f}); the mid-price mark is approximate.")
        open_px = num(o.get("open_price"))
        unreal = sign * (oq["mark"] - open_px) * mult * n if open_px is not None else None
        options.append({
            "open_price": r4(open_px), "unrealized": r2(unreal), "key": key,
            "label": label, "contract": oq["contract"],
            "underlying": o["underlying"], "type": typ, "position": o.get("position", "short"),
            "contracts": int(n) if n.is_integer() else n, "multiplier": int(mult), "strike": strike,
            "expiry": o["expiry"], "expiry_close_iso": exp_close.isoformat(), "dte": dte, "expired": oq["expired"],
            "spot": r2(spot), "distance": r2(dist), "distance_pct": r2(dist_pct),
            "status": "ITM" if itm else "OTM", "itm": itm, "covered": covered,
            "bid": oq["bid"], "ask": oq["ask"], "last": oq["last"], "mark": r4(oq["mark"]),
            "mark_source": oq["mark_source"], "intrinsic": r4(oq["intrinsic"]), "extrinsic": r4(extrinsic),
            "liability": r2(value), "day_change": r2(dchg), "prev_mark": r4(prev_mark), "prev_mark_source": pm_src,
            "iv": r4(oq["iv"]), "open_interest": oq["oi"], "volume": oq["volume"],
            "last_trade_et": et_str(oq["last_trade"]), "assignment_risk": risk, "assignment_note": risk_note,
            "prob_finish_itm": r4(p_itm), "assigned_proceeds": r2(strike * mult * n),
            "shares_at_risk": int(mult * n), "quote_quality": res["quality"], "quote_reused": res["reused"],
            "quote_as_of_et": res.get("quote_as_of_et") if res["reused"] else None,
        })

    total = stock_total + cash + opt_total
    day = stock_day + opt_day
    prev_total = total - day
    day_pct = day / prev_total * 100 if prev_total else None
    for p in positions:
        p["share_pct"] = r2(p["value"] / total * 100) if total else None
    cash_share = r2(cash / total * 100) if total else None

    # 3b) quotes for the Stocks list + precomputed charts (data/charts/<SYMBOL>.json); never fatal
    quote_map = build_quotes_and_charts(H, quotes, wquotes, watch, positions, options, trade_date, now,
                                        history, total, prev_total, cash, caveats)

    # 4) history upsert (one point per trading day)
    point = {"date": trade_date, "total": r2(total), "day_change": r2(day), "day_change_pct": r2(day_pct),
             "cash": r2(cash), "option_liability": r2(opt_total),
             "option_mark": r4(options[0]["mark"]) if options else None,
             "option_mark_source": options[0]["mark_source"] if options else None,
             "option_prev_mark": options[0]["prev_mark"] if options else None,
             "quote_quality": min(qualities) if qualities else Q_BIDASK,
             "quote_reused": any(o.get("quote_reused") for o in options),
             "positions": {p["symbol"]: {"value": p["value"], "day_pct": p["day_change_pct"]} for p in positions},
             "updated_et": stamp}
    existing = next((h for h in history if h["date"] == trade_date), None)
    # replace a session's row only with strictly better quotes, or equally good LIVE quotes (never with a
    # reused/off-hours snapshot of the same quality), or when it is the first record for the session
    old_q = (existing or {}).get("quote_quality") or 0
    if existing is None or point["quote_quality"] > old_q or (point["quote_quality"] == old_q and not point["quote_reused"]):
        history = [h for h in history if h["date"] != trade_date] + [point]
        history.sort(key=lambda h: h["date"])
    else:
        warn(f"history row {trade_date} kept: this run's option quote (quality {point['quote_quality']}"
             f"{', reused off-hours snapshot' if point['quote_reused'] else ''}) is not better than the recorded "
             f"one (quality {old_q})")

    # 5) paper lab
    lab = os.environ.get("PAPER_LAB_DIR") or os.path.join(os.path.dirname(ROOT), "spy-paper-lab")
    paper = None
    if os.path.isdir(lab):
        try:
            paper = build_paper_snapshot(lab)
            if paper:
                write_json(D("paper.json"), paper)
        except Exception as e:
            warn(f"paper lab snapshot failed: {e}")
    if paper is None:
        paper = load_json(D("paper.json"))
        if paper:
            caveats.append(f"Paper lab: showing saved snapshot (data through {paper.get('data_through')}).")

    # 6) summary stats
    totals = [h["total"] for h in history]
    days_with_change = [h for h in history if h.get("day_change") is not None]
    best = max(days_with_change, key=lambda h: h["day_change"]) if days_with_change else None
    worst = min(days_with_change, key=lambda h: h["day_change"]) if days_with_change else None

    states = {q["market_state"] for q in quotes.values()}
    mstate = "REGULAR" if "REGULAR" in states else sorted(states)[0]
    if mstate != "REGULAR":
        caveats.append(f"Market not in regular session ({MARKET_LABELS.get(mstate, mstate)}): stocks valued at the "
                       f"regular-session close; extended-hours quotes are not used.")
    caveats.append("Quotes from Yahoo Finance via yfinance (free, unofficial) and may be delayed ~15 minutes.")

    out = {
        "schema": 2,
        "generated_at_et": stamp,
        "generated_at_iso": now.isoformat(timespec="seconds"),
        "trade_date": trade_date,
        "quotes_as_of_et": et_str(max(q["quote_time"] for q in quotes.values())),
        "market_state": mstate,
        "market_label": MARKET_LABELS.get(mstate, mstate.title()),
        "delay_note": "Prices may be delayed ~15 minutes. Tracking only - not financial advice.",
        "account": {
            "total": r2(total), "prev_total": r2(prev_total), "day_change": r2(day), "day_change_pct": r2(day_pct),
            "stocks_value": r2(stock_total), "cash": r2(cash), "cash_share_pct": cash_share,
            "option_liability": r2(opt_total),
        },
        "positions": positions,
        "options": options,
        "stats": {
            "days_tracked": len(history), "all_time_high": max(totals) if totals else None,
            "best_day": {"date": best["date"], "change": best["day_change"], "pct": best.get("day_change_pct")} if best else None,
            "worst_day": {"date": worst["date"], "change": worst["day_change"], "pct": worst.get("day_change_pct")} if worst else None,
        },
        "history": [{"date": h["date"], "total": h["total"], "day_change": h.get("day_change"),
                     "day_change_pct": h.get("day_change_pct")} for h in history],
        "paper": paper,
        "watchlist": watch,
        "quotes": quote_map,
        "caveats": caveats,
    }

    old = load_json(D("portfolio.json"))
    if not force and old and strip_volatile(old) == strip_volatile(out):
        if new_state != state:
            write_json(D("option_state.json"), new_state)
        print(f"[{stamp}] no market-data change (total {total:.2f}); files left as-is")
        return
    write_json(D("history.json"), history)
    write_json(D("portfolio.json"), out)
    if new_state != state:
        write_json(D("option_state.json"), new_state)
    print(f"[{stamp}] total={total:.2f} day={day:+.2f} ({day_pct:+.2f}%) trade_date={trade_date} "
          f"positions={len(positions)} options={len(options)}")


if __name__ == "__main__":
    main()
