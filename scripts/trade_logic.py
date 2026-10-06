"""Pure portfolio-transaction logic used by scripts/apply_trade.py (and its tests).

apply_transaction(holdings, txn, today=..., check=None) -> (new_holdings, record)
  * never mutates `holdings` (works on a deep copy)
  * raises TradeError with a plain-English message on any validation problem

Transaction JSON (what the site's "Edit portfolio" form puts in the GitHub issue):
  {"v": 1, "type": "buy", "symbol": "UPRO", "qty": 10, "price": 150.25, "fees": 0,
   "option": {"right": "call", "strike": 154, "expiry": "2026-10-16"},   # option types only
   "amount": 100.0,                                                       # cash types only
   "date": "2026-10-06", "note": "optional text"}

Types: buy, sell, sell_to_open, buy_to_close, option_expired, option_assigned, deposit, withdraw,
       dividend, set_cash, set_cost_basis, watchlist_add, watchlist_remove
Cash rules (multiplier = 100 for options, 1 for stock):
  buy / buy_to_close:  cash -= qty * price * multiplier + fees
  sell / sell_to_open: cash += qty * price * multiplier - fees
  option_assigned (short call): shares -= 100 * contracts, cash += strike * 100 * contracts - fees
  option_assigned (short put):  shares += 100 * contracts, cash -= strike * 100 * contracts + fees
  option_expired: option removed, cash -= fees (normally 0)
  deposit / dividend: cash += amount;  withdraw: cash -= amount;  set_cash: cash = amount
Average cost: buys (and put assignments) update a weighted average cost per share that includes fees;
sells keep the average and report realized P/L when the average is known.
"""
import copy
import math
import re
from datetime import date, timedelta

TYPES = ("buy", "sell", "sell_to_open", "buy_to_close", "option_expired", "option_assigned",
         "deposit", "withdraw", "dividend", "set_cash", "set_cost_basis", "watchlist_add", "watchlist_remove")
ALIASES = {
    "buy": "buy", "sell": "sell",
    "sell_to_open": "sell_to_open", "sto": "sell_to_open", "sell_to_open_option": "sell_to_open",
    "buy_to_close": "buy_to_close", "btc": "buy_to_close", "buy_to_close_option": "buy_to_close",
    "option_expired": "option_expired", "expired": "option_expired", "expire": "option_expired",
    "option_assigned": "option_assigned", "assigned": "option_assigned", "assignment": "option_assigned",
    "deposit": "deposit", "withdraw": "withdraw", "withdrawal": "withdraw", "dividend": "dividend",
    "set_cash": "set_cash", "set_cost_basis": "set_cost_basis", "set_avg_cost": "set_cost_basis",
    "watchlist_add": "watchlist_add", "watch_add": "watchlist_add", "add_to_watchlist": "watchlist_add",
    "watchlist_remove": "watchlist_remove", "watch_remove": "watchlist_remove",
    "remove_from_watchlist": "watchlist_remove",
}
STOCK_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
WATCH_RE = re.compile(r"^[A-Z0-9\^][A-Z0-9.\-=\^]{0,14}$")
MAX_NOTE = 300
EPS = 1e-9


class TradeError(ValueError):
    pass


# ------------------------------------------------------------------ small helpers
def _r2(x):
    return round(x + 0.0, 2)


def _clean_num(x):
    x = round(float(x), 6)
    return int(x) if x.is_integer() else x


def money(x):
    return ("-" if x < 0 else "") + f"${abs(x):,.2f}"


def _num(txn, key, *, required=False, positive=False, nonneg=False, integer=False, label=None):
    label = label or key
    v = txn.get(key)
    if v is None or (isinstance(v, str) and not v.strip()):
        if required:
            raise TradeError(f"'{label}' is required for a {txn['type'].replace('_', ' ')}.")
        return None
    try:
        f = float(str(v).replace(",", "").replace("$", "").strip()) if isinstance(v, str) else float(v)
    except (TypeError, ValueError):
        raise TradeError(f"'{label}' must be a number (got {v!r}).")
    if isinstance(v, bool) or math.isnan(f) or math.isinf(f):
        raise TradeError(f"'{label}' must be a number (got {v!r}).")
    if positive and f <= 0:
        raise TradeError(f"'{label}' must be greater than 0 (got {v}).")
    if nonneg and f < 0:
        raise TradeError(f"'{label}' cannot be negative (got {v}).")
    if integer and abs(f - round(f)) > EPS:
        raise TradeError(f"'{label}' must be a whole number of contracts (got {v}).")
    if abs(f) > 1e9:
        raise TradeError(f"'{label}' is unrealistically large ({v}).")
    return float(round(f)) if integer else f


def _date(s, label):
    try:
        return date.fromisoformat(str(s).strip())
    except ValueError:
        raise TradeError(f"'{label}' must be a date like 2026-10-16 (got {s!r}).")


def normalize(txn, today):
    """Validate field formats and return a clean copy (type/symbol normalised, numbers parsed)."""
    if not isinstance(txn, dict):
        raise TradeError("The transaction must be a JSON object.")
    t = dict(txn)
    raw = str(t.get("type") or "").strip().lower()
    key = re.sub(r"[^a-z]+", "_", raw).strip("_")
    if key not in ALIASES:
        raise TradeError(f"Unknown type {t.get('type')!r}. Use one of: {', '.join(TYPES)}.")
    t["type"] = typ = ALIASES[key]
    sym = str(t.get("symbol") or "").strip().upper()
    t["symbol"] = sym or None
    note = str(t.get("note") or "").strip()
    if len(note) > MAX_NOTE:
        raise TradeError(f"Note is too long ({len(note)} characters, max {MAX_NOTE}).")
    t["note"] = note
    d = _date(t["date"], "date") if t.get("date") else today
    if d > today + timedelta(days=1):
        raise TradeError(f"Date {d.isoformat()} is in the future.")
    if d < date(2000, 1, 1):
        raise TradeError(f"Date {d.isoformat()} is too far in the past.")
    t["date"] = d.isoformat()
    t["fees"] = _num(t, "fees", nonneg=True) or 0.0
    if t["fees"] > 10000:
        raise TradeError(f"Fees of {t['fees']} look wrong.")

    if typ in ("buy", "sell", "sell_to_open", "set_cost_basis", "watchlist_add", "watchlist_remove") and not sym:
        raise TradeError(f"'symbol' is required for a {typ.replace('_', ' ')}.")
    if sym:
        pat = WATCH_RE if typ.startswith("watchlist") else STOCK_RE
        if not pat.match(sym):
            raise TradeError(f"{sym!r} does not look like a ticker symbol.")

    opt_types = ("sell_to_open", "buy_to_close", "option_expired", "option_assigned")
    if typ in ("buy", "sell"):
        t["qty"] = _num(t, "qty", required=True, positive=True)
        t["price"] = _num(t, "price", required=True, positive=True)
    elif typ in opt_types:
        t["qty"] = _num(t, "qty", required=typ in ("sell_to_open", "buy_to_close"), positive=True, integer=True,
                        label="qty (contracts)")
        if typ == "sell_to_open":
            t["price"] = _num(t, "price", required=True, positive=True, label="price (premium per share)")
        elif typ == "buy_to_close":
            t["price"] = _num(t, "price", required=True, nonneg=True, label="price (per share)")
        o = t.get("option") or {}
        if not isinstance(o, dict):
            raise TradeError("'option' must be an object with right, strike and expiry.")
        o = dict(o)
        right = str(o.get("right") or o.get("type") or "").strip().lower()
        if right in ("c", "calls"):
            right = "call"
        if right in ("p", "puts"):
            right = "put"
        if right and right not in ("call", "put"):
            raise TradeError(f"Option right must be call or put (got {o.get('right')!r}).")
        strike = _num(o | {"type": typ}, "strike", positive=True, label="strike") if o.get("strike") not in (None, "") else None
        expiry = _date(o["expiry"], "expiry").isoformat() if o.get("expiry") else None
        mult = _num(o | {"type": typ}, "multiplier", positive=True, label="multiplier") or 100.0
        if typ == "sell_to_open":
            missing = [k for k, v in (("right", right), ("strike", strike), ("expiry", expiry)) if not v]
            if missing:
                raise TradeError(f"Option {', '.join(missing)} required to sell to open.")
            if expiry < t["date"]:
                raise TradeError(f"Expiry {expiry} is before the trade date {t['date']}.")
        t["option"] = {"right": right or None, "strike": strike, "expiry": expiry, "multiplier": mult}
    elif typ in ("deposit", "withdraw", "dividend", "set_cash"):
        if t.get("amount") in (None, "") and t.get("price") not in (None, "") and typ != "dividend":
            t["amount"] = t["price"]
        if typ == "dividend" and t.get("amount") in (None, "") and t.get("price") not in (None, "") and t.get("qty") not in (None, ""):
            t["amount"] = _num(t, "qty", positive=True) * _num(t, "price", positive=True)
        t["amount"] = _num(t, "amount", required=True, positive=typ != "set_cash", nonneg=True)
    elif typ == "set_cost_basis":
        t["price"] = _num(t, "price", required=True, nonneg=True, label="price (average cost per share)")
    return t


# ------------------------------------------------------------------ holdings access
def _stock(H, sym):
    return next((s for s in H.setdefault("stocks", []) if s["symbol"].upper() == sym), None)


def _short_calls(H, und):
    return sum(float(o["contracts"]) * float(o.get("multiplier", 100)) for o in H.get("options", [])
               if o["underlying"].upper() == und and o["type"].lower() == "call" and o.get("position", "short") == "short")


def _match_option(H, t):
    o = t["option"]
    cands = [x for x in H.get("options", [])
             if (not t["symbol"] or x["underlying"].upper() == t["symbol"])
             and (not o["right"] or x["type"].lower() == o["right"])
             and (o["strike"] is None or abs(float(x["strike"]) - o["strike"]) < 1e-6)
             and (not o["expiry"] or x["expiry"] == o["expiry"])]
    if not cands:
        raise TradeError("No open option matches " + opt_label(t) + ". Open options: " +
                         (", ".join(hold_opt_label(x) for x in H.get("options", [])) or "none") + ".")
    if len(cands) > 1:
        raise TradeError("More than one open option matches; give the right, strike and expiry. Matches: " +
                         ", ".join(hold_opt_label(x) for x in cands) + ".")
    return cands[0]


def hold_opt_label(x):
    return f"{x.get('position', 'short')} {x['contracts']:g} {x['underlying']} {date.fromisoformat(x['expiry']).strftime('%b %d %Y')} " \
           f"${float(x['strike']):g} {x['type']}"


def opt_label(t):
    o = t.get("option") or {}
    parts = [t.get("symbol") or ""]
    if o.get("expiry"):
        parts.append(date.fromisoformat(o["expiry"]).strftime("%b %d %Y"))
    if o.get("strike") is not None:
        parts.append(f"${o['strike']:g}")
    if o.get("right"):
        parts.append(o["right"])
    return " ".join(p for p in parts if p) or "(unspecified option)"


def describe(t):
    """One-line human description, e.g. 'Buy 10 UPRO @ $150.25'."""
    typ = t["type"]
    q = lambda x: f"{x:g}"
    if typ == "buy":
        return f"Buy {q(t['qty'])} {t['symbol']} @ {money(t['price'])}"
    if typ == "sell":
        return f"Sell {q(t['qty'])} {t['symbol']} @ {money(t['price'])}"
    if typ == "sell_to_open":
        return f"Sell to open {q(t['qty'])} {opt_label(t)} @ {money(t['price'])}"
    if typ == "buy_to_close":
        return f"Buy to close {q(t['qty'])} {opt_label(t)} @ {money(t['price'])}"
    if typ == "option_expired":
        return f"Option expired: {opt_label(t)}"
    if typ == "option_assigned":
        return f"Option assigned: {opt_label(t)}"
    if typ in ("deposit", "withdraw"):
        return f"{typ.title()} {money(t['amount'])}"
    if typ == "dividend":
        return f"Dividend {money(t['amount'])}" + (f" from {t['symbol']}" if t.get("symbol") else "")
    if typ == "set_cash":
        return f"Set cash to {money(t['amount'])}"
    if typ == "set_cost_basis":
        return f"Set cost basis {t['symbol']}" + (f" {opt_label(t)}" if t.get("option") else "") + f" = {money(t['price'])}"
    if typ == "watchlist_add":
        return f"Watchlist add {t['symbol']}"
    if typ == "watchlist_remove":
        return f"Watchlist remove {t['symbol']}"
    return typ


def summarize(H):
    """Flat dict of everything a transaction can change, for before/after comments."""
    out = {"Cash": money(float(H.get("cash", 0)))}
    for s in H.get("stocks", []):
        avg = s.get("avg_cost")
        out[s["symbol"]] = f"{float(s['shares']):g} sh" + (f" @ avg {money(float(avg))}" if avg is not None else " (avg cost not set)")
    for o in H.get("options", []):
        k = f"{o['underlying']} {date.fromisoformat(o['expiry']).strftime('%b %d %Y')} ${float(o['strike']):g} {o['type']}"
        out[k] = f"{o.get('position', 'short')} {float(o['contracts']):g}" + (
            f" (opened @ {money(float(o['open_price']))})" if o.get("open_price") is not None else "")
    out["Watchlist"] = ", ".join(H.get("watchlist", [])) or "(empty)"
    return out


# ------------------------------------------------------------------ apply
def apply_transaction(holdings, txn, today=None, check=None):
    """check(kind, t) is an optional callback ("symbol" / "option") that raises TradeError for unknown
    symbols/contracts; tests pass None (no network)."""
    today = today or date.today()
    t = normalize(txn, today)
    H = copy.deepcopy(holdings)
    H.setdefault("stocks", [])
    H.setdefault("options", [])
    H.setdefault("watchlist", [])
    cash0 = float(H.get("cash", 0))
    cash = cash0
    fees = t["fees"]
    typ = t["type"]
    rec = {"type": typ, "date": t["date"], "symbol": t.get("symbol"), "fees": fees, "note": t["note"]}
    realized = None

    if typ == "buy":
        sym, qty, px = t["symbol"], t["qty"], t["price"]
        s = _stock(H, sym)
        if s is None and check:
            check("symbol", t)
        cost = qty * px + fees
        cash -= cost
        if s is None:
            H["stocks"].append({"symbol": sym, "shares": _clean_num(qty), "avg_cost": round(cost / qty, 4)})
        else:
            old = float(s["shares"])
            new = old + qty
            if s.get("avg_cost") is not None or old <= EPS:
                old_cost = float(s.get("avg_cost") or 0) * old
                s["avg_cost"] = round((old_cost + cost) / new, 4)
            s["shares"] = _clean_num(new)
        rec.update(qty=qty, price=px)

    elif typ == "sell":
        sym, qty, px = t["symbol"], t["qty"], t["price"]
        s = _stock(H, sym)
        if s is None:
            raise TradeError(f"You don't hold {sym}, so it can't be sold.")
        old = float(s["shares"])
        if qty > old + EPS:
            raise TradeError(f"Can't sell {qty:g} {sym}: only {old:g} held.")
        left = old - qty
        covered_need = _short_calls(H, sym)
        if left + EPS < covered_need:
            raise TradeError(f"Selling {qty:g} {sym} would leave {left:g} shares, but the short call(s) need "
                             f"{covered_need:g} shares to stay covered. Close or roll the call first.")
        cash += qty * px - fees
        if s.get("avg_cost") is not None:
            realized = (px - float(s["avg_cost"])) * qty - fees
        if left <= EPS:
            H["stocks"] = [x for x in H["stocks"] if x is not s]
        else:
            s["shares"] = _clean_num(left)
        rec.update(qty=qty, price=px)

    elif typ == "sell_to_open":
        o, qty, px = t["option"], t["qty"], t["price"]
        und = t["symbol"]
        if check:
            check("option", t)
        mult = o["multiplier"]
        same = [x for x in H["options"] if x["underlying"].upper() == und and x["type"].lower() == o["right"]
                and abs(float(x["strike"]) - o["strike"]) < 1e-6 and x["expiry"] == o["expiry"]]
        if same and same[0].get("position", "short") != "short":
            raise TradeError("You hold this contract long; selling it would close a long position, which this form "
                             "doesn't support.")
        if o["right"] == "call":
            s = _stock(H, und)
            shares = float(s["shares"]) if s else 0.0
            need = _short_calls(H, und) + qty * mult
            if shares + EPS < need:
                raise TradeError(f"Uncovered call: selling {qty:g} {und} call(s) needs {need:g} shares in total, "
                                 f"but only {shares:g} are held.")
        cash += qty * px * mult - fees
        if same:
            x = same[0]
            n0 = float(x["contracts"])
            if x.get("open_price") is not None:
                x["open_price"] = round((float(x["open_price"]) * n0 + px * qty) / (n0 + qty), 4)
            x["contracts"] = _clean_num(n0 + qty)
        else:
            H["options"].append({"underlying": und, "type": o["right"], "position": "short", "contracts": _clean_num(qty),
                                 "multiplier": _clean_num(mult), "strike": o["strike"], "expiry": o["expiry"],
                                 "open_price": round(px, 4)})
        rec.update(qty=qty, price=px, option=o)

    elif typ in ("buy_to_close", "option_expired", "option_assigned"):
        x = _match_option(H, t)
        if x.get("position", "short") != "short":
            raise TradeError(f"{hold_opt_label(x)} is a long position; this form only handles short options.")
        n0 = float(x["contracts"])
        qty = t["qty"] if t.get("qty") else n0
        if qty > n0 + EPS:
            raise TradeError(f"Only {n0:g} contract(s) of {hold_opt_label(x)} are open (got {qty:g}).")
        mult = float(x.get("multiplier", 100))
        strike = float(x["strike"])
        und = x["underlying"].upper()
        t["symbol"] = und
        t["option"] = {"right": x["type"].lower(), "strike": strike, "expiry": x["expiry"], "multiplier": mult}
        rec["symbol"] = und
        op = x.get("open_price")
        if typ == "buy_to_close":
            px = t["price"]
            cash -= qty * px * mult + fees
            if op is not None:
                realized = (float(op) - px) * qty * mult - fees
            rec.update(price=px)
        elif typ == "option_expired":
            if x["expiry"] > t["date"]:
                raise TradeError(f"{hold_opt_label(x)} expires {x['expiry']}, after the date given ({t['date']}).")
            cash -= fees
            if op is not None:
                realized = float(op) * qty * mult - fees
        else:  # assigned
            shares_n = qty * mult
            s = _stock(H, und)
            if x["type"].lower() == "call":
                held = float(s["shares"]) if s else 0.0
                if held + EPS < shares_n:
                    raise TradeError(f"Assignment needs {shares_n:g} {und} shares but only {held:g} are held.")
                cash += strike * shares_n - fees
                if s.get("avg_cost") is not None:
                    realized = (strike - float(s["avg_cost"])) * shares_n - fees
                left = held - shares_n
                if left <= EPS:
                    H["stocks"] = [y for y in H["stocks"] if y is not s]
                else:
                    s["shares"] = _clean_num(left)
            else:
                cost = strike * shares_n + fees
                cash -= cost
                if s is None:
                    H["stocks"].append({"symbol": und, "shares": _clean_num(shares_n), "avg_cost": round(cost / shares_n, 4)})
                else:
                    old = float(s["shares"])
                    if s.get("avg_cost") is not None or old <= EPS:
                        s["avg_cost"] = round((float(s.get("avg_cost") or 0) * old + cost) / (old + shares_n), 4)
                    s["shares"] = _clean_num(old + shares_n)
            rec.update(price=strike)
        left = n0 - qty
        if left <= EPS:
            H["options"] = [y for y in H["options"] if y is not x]
        else:
            x["contracts"] = _clean_num(left)
        rec.update(qty=qty, option=t["option"])

    elif typ == "deposit":
        cash += t["amount"]
        rec["amount"] = t["amount"]
    elif typ == "withdraw":
        cash -= t["amount"]
        rec["amount"] = t["amount"]
    elif typ == "dividend":
        cash += t["amount"]
        rec["amount"] = t["amount"]
    elif typ == "set_cash":
        cash = t["amount"]
        rec["amount"] = t["amount"]
    elif typ == "set_cost_basis":
        s = _stock(H, t["symbol"])
        if s is None:
            raise TradeError(f"You don't hold {t['symbol']}.")
        s["avg_cost"] = round(t["price"], 4)
        rec["price"] = t["price"]
    elif typ == "watchlist_add":
        sym = t["symbol"]
        if sym in [w.upper() for w in H["watchlist"]]:
            raise TradeError(f"{sym} is already on the watchlist.")
        if len(H["watchlist"]) >= 25:
            raise TradeError("The watchlist is full (25 symbols).")
        if check:
            check("symbol", t)
        H["watchlist"].append(sym)
    elif typ == "watchlist_remove":
        sym = t["symbol"]
        if sym not in [w.upper() for w in H["watchlist"]]:
            raise TradeError(f"{sym} is not on the watchlist (it has: {', '.join(H['watchlist']) or 'nothing'}).")
        H["watchlist"] = [w for w in H["watchlist"] if w.upper() != sym]

    if typ in ("buy", "buy_to_close", "withdraw", "option_assigned", "option_expired") and cash < -0.005:
        raise TradeError(f"Not enough cash: this would take cash from {money(cash0)} to {money(cash)}. "
                         f"If cash is out of date, submit a Deposit or Set cash first.")
    H["cash"] = _r2(cash)
    if typ not in ("watchlist_add", "watchlist_remove"):
        H["as_of"] = max(str(H.get("as_of") or ""), t["date"])
    rec.update(description=describe(t), cash_before=_r2(cash0), cash_after=H["cash"],
               realized_pl=None if realized is None else _r2(realized))
    rec = {k: v for k, v in rec.items() if v is not None and v != ""}
    return H, rec
