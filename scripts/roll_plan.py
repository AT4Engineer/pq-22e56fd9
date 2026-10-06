"""Monthly covered-call roll plan: "this month", "next roll preview" and "roll history".

Pure functions (no network) plus fetch_calls() which reads one real call chain from Yahoo via yfinance.
Nothing here invents prices: a missing bid/ask stays None and the site shows "n/a".
"""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def _num(x):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _r(x, n=2):
    return None if x is None else round(x + 0.0, n)


def third_friday(y, m):
    d = date(y, m, 15)  # the third Friday is always the 15th-21st
    return d + timedelta(days=(4 - d.weekday()) % 7)


def next_monthly_expiry(after):
    """Third-Friday monthly expiry strictly after `after` (Oct 16 2026 -> Nov 20 2026)."""
    c = third_friday(after.year, after.month)
    if c <= after:
        y, m = (after.year + 1, 1) if after.month == 12 else (after.year, after.month + 1)
        c = third_friday(y, m)
    return c


def choose_expiry(listed, target):
    """Exact target if Yahoo lists it, else the first listed expiry on/after it (or None)."""
    iso = target.isoformat()
    if iso in listed:
        return iso, None
    later = sorted(e for e in listed if e >= iso)
    if later:
        return later[0], f"{iso} is not listed; using the next listed expiry {later[0]}."
    return None, f"No listed expiry on or after {iso}."


def two_sided(r):
    b, a = (r or {}).get("bid"), (r or {}).get("ask")
    return bool(b and a and b > 0 and a > 0 and a >= b)


def chain_rows(df):
    rows = []
    for _, x in df.iterrows():
        bid, ask = _num(x.get("bid")), _num(x.get("ask"))
        lt = x.get("lastTradeDate")
        try:
            lt = lt.tz_convert(ET).strftime("%Y-%m-%d %H:%M ET") if lt is not None else None
        except Exception:  # noqa: BLE001
            lt = None
        r = {"strike": _num(x["strike"]), "contract": x.get("contractSymbol"), "bid": bid, "ask": ask,
             "last": _num(x.get("lastPrice")), "iv": _r(_num(x.get("impliedVolatility")), 4),
             "oi": _num(x.get("openInterest")), "volume": _num(x.get("volume")), "last_trade_et": lt}
        r["mid"] = _r((bid + ask) / 2, 3) if two_sided(r) else None
        rows.append(r)
    return sorted(rows, key=lambda r: r["strike"])


def fetch_calls(und, expiry):
    import yfinance as yf
    return chain_rows(yf.Ticker(und).option_chain(expiry).calls)


def listed_expiries(und):
    import yfinance as yf
    return list(yf.Ticker(und).options or [])


def pick_atm(rows, spot, n=2):
    """Strike nearest the share price (a tie goes to the higher strike) plus n strikes each side."""
    rows = [r for r in rows if r.get("strike")]
    if not rows or not spot:
        return None, []
    i = min(range(len(rows)), key=lambda k: (abs(rows[k]["strike"] - spot), -rows[k]["strike"]))
    return rows[i], rows[max(0, i - n): i + n + 1]


def fmt_money(x):
    return ("-" if x < 0 else "") + f"${abs(x):,.2f}"


def this_month(o, open_price, now):
    """o = the option dict build_data.py writes to portfolio.json (already has the resolved quote)."""
    n, mult = float(o["contracts"]), float(o.get("multiplier", 100))
    size = n * mult
    exp = date.fromisoformat(o["expiry"])
    close_dt = datetime.combine(exp, time(16, 0), ET)
    bid, ask, mark = _num(o.get("bid")), _num(o.get("ask")), _num(o.get("mark"))
    mid = (bid + ask) / 2 if two_sided(o) else None
    buy_ask = ask * size if ask and ask > 0 else None
    buy_mid = mid * size if mid is not None else None
    prem = open_price * size if open_price is not None else None
    secs = (close_dt - now).total_seconds()
    return {
        "label": o["label"], "contract": o.get("contract"), "key": o.get("key"), "underlying": o["underlying"],
        "strike": o["strike"], "expiry": o["expiry"], "contracts": o["contracts"], "multiplier": int(mult),
        "spot": o.get("spot"), "itm": o.get("itm"),
        "mark": _r(mark, 4), "bid": bid, "ask": ask, "mid": _r(mid, 4), "mark_source": o.get("mark_source"),
        "quote_reused": o.get("quote_reused"), "quote_as_of_et": o.get("quote_as_of_et"),
        "buyback_ask": _r(buy_ask), "buyback_mid": _r(buy_mid), "buyback_mark": _r(mark * size) if mark is not None else None,
        "premium_received_per_share": open_price, "premium_received": _r(prem),
        "pl_if_closed_ask": _r(prem - buy_ask) if prem is not None and buy_ask is not None else None,
        "pl_if_closed_mid": _r(prem - buy_mid) if prem is not None and buy_mid is not None else None,
        "deadline_iso": close_dt.isoformat(),
        "deadline_text": f"Buy to close before 4:00 PM ET {exp.strftime('%a %b')} {exp.day} to keep your shares",
        "expired": secs <= 0,
    }


def preview(rows, spot, contracts, mult, buyback_ask, expiry, today, quote_note=None):
    atm, near = pick_atm(rows, spot)
    size = float(contracts) * float(mult)
    exp = date.fromisoformat(expiry)
    days = (exp - today).days
    out = {"expiry": expiry, "expiry_label": f"{exp.strftime('%a %b')} {exp.day} {exp.year}", "days": days,
           "spot": _r(spot), "contracts": contracts, "multiplier": int(mult), "quote_note": quote_note,
           "strikes": [dict(r, atm=bool(atm and r["strike"] == atm["strike"])) for r in near]}
    if not atm:
        out["note"] = "No strikes in this chain."
        return out
    k, bid, ask = atm["strike"], atm.get("bid"), atm.get("ask")
    has_bid = bool(bid and bid > 0)
    prem = bid * size if has_bid else None
    out.update(atm_strike=k, contract=atm.get("contract"), bid=bid, ask=ask, mid=atm.get("mid"), last=atm.get("last"),
               iv=atm.get("iv"), oi=atm.get("oi"), volume=atm.get("volume"), last_trade_et=atm.get("last_trade_et"),
               est_premium=_r(prem),
               net_roll=_r(prem - buyback_ask) if prem is not None and buyback_ask is not None else None,
               premium_pct=_r(bid / spot * 100) if has_bid and spot else None,
               annualized_pct=_r(bid / spot * 100 * 365 / days, 1) if has_bid and spot and days > 0 else None,
               breakeven=_r(spot - bid) if has_bid and spot else None,
               called_away_value=_r(k * size),
               max_gain_vs_today=_r((k - spot) * size + prem) if prem is not None and spot else None)
    km = f"${k:g}"
    p = fmt_money(prem) if prem is not None else "the premium"
    out["above_text"] = (f"Above {km} on {out['expiry_label']}: the call is in the money. Buy it back before 4:00 PM ET "
                         f"to keep the shares and roll again (it costs more the higher UPRO is), or let the "
                         f"{int(size)} shares be sold at {km} ({fmt_money(k * size)}). You keep {p} either way.")
    out["below_text"] = (f"Below {km}: the call expires worthless. You keep {p} and the {int(size)} shares, "
                         f"which are worth less if UPRO fell.")
    if not has_bid:
        out["note"] = "No bid for this strike right now, so the premium can't be estimated."
    return out


def _olabel(o, und):
    e = date.fromisoformat(o["expiry"])
    return f"{und} {e.strftime('%b')} {e.day} {e.year} ${float(o['strike']):g} {o.get('right') or 'call'}"


def history(txns, holdings):
    """One row per short-call contract from data/transactions.json (+ the open contract from holdings)."""
    cyc, order = {}, []

    def get(und, o):
        k = (und, o["expiry"], float(o["strike"]), (o.get("right") or "call"))
        if k not in cyc:
            cyc[k] = {"label": _olabel(o, und), "underlying": und, "expiry": o["expiry"], "strike": float(o["strike"]),
                      "opened": None, "premium": None, "premium_source": None, "closed": None, "close_action": None,
                      "close_cost": None, "rolled_to": None, "roll_id": None, "open": False}
            order.append(k)
        return cyc[k]

    for t in sorted(txns or [], key=lambda x: (x.get("date") or "", str(x.get("applied_at_et") or ""))):
        o = t.get("option")
        typ = t.get("type")
        if not isinstance(o, dict) or not o.get("expiry") or o.get("strike") is None:
            continue
        if (o.get("right") or "call") != "call":
            continue
        und, mult = (t.get("symbol") or "").upper(), float(o.get("multiplier") or 100)
        qty, px, fees = float(t.get("qty") or 1), _num(t.get("price")), float(t.get("fees") or 0)
        c = get(und, o)
        if typ == "sell_to_open" and px is not None:
            add = px * qty * mult - fees
            c["premium"] = (c["premium"] or 0) + add if c["premium_source"] == "sell to open" else add
            c["premium_source"], c["opened"] = "sell to open", c["opened"] or t.get("date")
        elif typ == "set_option_premium" and px is not None and c["premium_source"] != "sell to open":
            c["premium"], c["premium_source"] = px * qty * mult, "entered"
        elif typ == "buy_to_close" and px is not None:
            c["close_cost"] = (c["close_cost"] or 0) + px * qty * mult + fees
            c["closed"], c["close_action"] = t.get("date"), "Bought back"
            if t.get("roll_id"):
                c["roll_id"] = t["roll_id"]
        elif typ == "option_expired":
            c["closed"], c["close_action"], c["close_cost"] = t.get("date"), "Expired worthless", fees
        elif typ == "option_assigned":
            c["closed"], c["close_action"], c["close_cost"] = t.get("date"), f"Assigned at ${float(o['strike']):g}", fees
    # roll links: the sell-to-open leg sharing a roll_id is the "rolled to" contract
    for t in txns or []:
        if t.get("roll_id") and t.get("type") == "sell_to_open":
            for c in cyc.values():
                if c["roll_id"] == t["roll_id"] and c["close_action"] == "Bought back":
                    c["rolled_to"] = _olabel(t["option"], (t.get("symbol") or "").upper())
    for o in (holdings or {}).get("options", []):
        if o.get("type", "call").lower() != "call" or o.get("position", "short") != "short":
            continue
        c = get(o["underlying"].upper(), {"expiry": o["expiry"], "strike": o["strike"], "right": "call"})
        c["open"], c["closed"], c["close_action"] = True, None, "Open"
        if c["premium"] is None and o.get("open_price") is not None:
            c["premium"] = float(o["open_price"]) * float(o["contracts"]) * float(o.get("multiplier", 100))
            c["premium_source"] = "entered"
    rows, cum, prem_t, cost_t = [], 0.0, 0.0, 0.0
    for k in sorted(order, key=lambda k: (k[1], k[2])):
        c = cyc[k]
        p, cost = c["premium"], c["close_cost"]
        prem_t += p or 0
        cost_t += cost or 0
        cum += (p or 0) - (cost or 0)
        c["net"] = _r(p - (cost or 0)) if p is not None and (cost is not None or not c["open"]) else None
        c["premium"], c["close_cost"], c["cumulative"] = _r(p), _r(cost), _r(cum)
        rows.append(c)
    return {"rows": rows, "premiums_total": _r(prem_t), "buybacks_total": _r(cost_t), "net_total": _r(prem_t - cost_t),
            "missing_premium": any(r["premium"] is None for r in rows)}
