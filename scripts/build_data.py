#!/usr/bin/env python3
"""Build data/portfolio.json for the static dashboard.

Reads data/holdings.json, fetches quotes from Yahoo Finance via yfinance, values the
account (stocks + cash - short option liability), upserts one point per trading day into
data/history.json, attaches a small SPY paper-lab snapshot (data/paper.json), and writes data/portfolio.json.

Never fabricates prices: if a stock quote cannot be fetched the script exits non-zero and
leaves the existing files untouched.

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
    return {
        "symbol": symbol,
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
        positions.append({
            "symbol": s["symbol"], "name": s.get("display_name") or q["name"], "long_name": q["name"],
            "exchange": s.get("exchange") or q["exchange"], "shares": int(qty) if qty.is_integer() else qty,
            "price": r2(q["price"]), "prev_close": r2(q["prev_close"]), "day_change_per_share": r2(unit),
            "day_change": r2(dchg), "day_change_pct": r2(dpct), "value": r2(mv),
            "quote_time_et": et_str(q["quote_time"]), "market_state": q["market_state"], "price_source": q["source"],
            "ext_price": r2(q["ext_price"]), "ext_label": q["ext_label"],
        })

    # 3) options
    options, opt_total, opt_day = [], 0.0, 0.0
    for o in H.get("options", []):
        spot = quotes[o["underlying"]]["price"]
        oq = get_option(o, spot, now)
        n, mult = float(o["contracts"]), float(o.get("multiplier", 100))
        sign = -1 if o.get("position", "short") == "short" else 1
        value = sign * oq["mark"] * mult * n
        prev_mark, pm_src = None, None
        if prev_hist and prev_hist.get("option_mark") is not None:
            prev_mark, pm_src = num(prev_hist["option_mark"]), f"tracked mark on {prev_hist['date']}"
        if prev_mark is None and oq["chain_prev_close"] is not None:
            prev_mark, pm_src = oq["chain_prev_close"], "option's prior close (last - change)"
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
        if spread is not None and oq["mark"] and spread / oq["mark"] > 0.25:
            caveats.append(f"{label}: wide bid/ask ({oq['bid']:.2f} x {oq['ask']:.2f}); the mid-price mark is approximate.")
        options.append({
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
            "shares_at_risk": int(mult * n),
        })

    total = stock_total + cash + opt_total
    day = stock_day + opt_day
    prev_total = total - day
    day_pct = day / prev_total * 100 if prev_total else None
    for p in positions:
        p["share_pct"] = r2(p["value"] / total * 100) if total else None
    cash_share = r2(cash / total * 100) if total else None

    # 4) history upsert (one point per trading day)
    point = {"date": trade_date, "total": r2(total), "day_change": r2(day), "day_change_pct": r2(day_pct),
             "cash": r2(cash), "option_liability": r2(opt_total),
             "option_mark": r4(options[0]["mark"]) if options else None,
             "positions": {p["symbol"]: {"value": p["value"], "day_pct": p["day_change_pct"]} for p in positions},
             "updated_et": stamp}
    history = [h for h in history if h["date"] != trade_date] + [point]
    history.sort(key=lambda h: h["date"])

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
        "caveats": caveats,
    }

    old = load_json(D("portfolio.json"))
    if not force and old and strip_volatile(old) == strip_volatile(out):
        print(f"[{stamp}] no market-data change (total {total:.2f}); files left as-is")
        return
    write_json(D("history.json"), history)
    write_json(D("portfolio.json"), out)
    print(f"[{stamp}] total={total:.2f} day={day:+.2f} ({day_pct:+.2f}%) trade_date={trade_date} "
          f"positions={len(positions)} options={len(options)}")


if __name__ == "__main__":
    main()
