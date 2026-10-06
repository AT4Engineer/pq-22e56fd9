#!/usr/bin/env python3
"""Apply one portfolio transaction from a GitHub issue (used by .github/workflows/apply-trade.yml).

CI mode (the workflow):
  python scripts/apply_trade.py --event "$GITHUB_EVENT_PATH"
    1. parses the fenced ```json block in the issue body
    2. git fetch + reset to origin/main, skips if this issue was already applied (duplicate event)
    3. validates and applies it to data/holdings.json (scripts/trade_logic.py), appends data/transactions.json
    4. reruns build_data.py --force, history_csv.py, current_csv.py, intraday_csv.py, build_standalone.py
    5. commits and pushes (retrying from a fresh origin/main if another run pushed first)
    6. comments a before/after summary on the issue and closes it
  On a validation error it comments the error, closes the issue as "not planned" and changes nothing.

Local mode (no git, no GitHub):
  python scripts/apply_trade.py --txn trade.json [--data-dir DIR] [--dry-run]
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trade_logic import TradeError, apply_transaction, summarize  # noqa: E402

ET = ZoneInfo("America/New_York")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = os.environ.get("TRADE_OWNER", "AT4Engineer")
FENCE = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.S | re.I)


def parse_body(body):
    body = (body or "").strip()
    m = FENCE.search(body)
    raw = m.group(1) if m else body
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        raise TradeError(f"Could not read the JSON in the issue body ({e.msg} at line {e.lineno}). "
                         "Submit the trade again from the site's Edit form.")
    if not isinstance(obj, dict):
        raise TradeError("The issue body must contain one JSON object.")
    return obj


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def dump(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def online_check(kind, t):
    """Reject symbols / option contracts Yahoo doesn't know (so a typo can't break the price updates).
    Network problems are not treated as errors."""
    try:
        import yfinance as yf
    except ImportError:
        return
    sym = t["symbol"]
    try:
        tk = yf.Ticker(sym)
        if kind == "symbol":
            h = tk.history(period="5d")
            if h is None or h.empty:
                raise TradeError(f"Yahoo Finance has no prices for {sym!r}; check the symbol.")
        elif kind == "option":
            o = t["option"]
            exps = tk.options
            if not exps:
                raise TradeError(f"No listed options found for {sym!r}.")
            if o["expiry"] not in exps:
                raise TradeError(f"{sym} has no option expiring {o['expiry']} (next expiries: {', '.join(exps[:6])}).")
            ch = tk.option_chain(o["expiry"])
            df = ch.calls if o["right"] == "call" else ch.puts
            if not ((df["strike"] - o["strike"]).abs() < 1e-6).any():
                raise TradeError(f"No {sym} {o['expiry']} {o['right']} at strike {o['strike']:g}.")
    except TradeError:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"[warn] symbol check skipped ({e})", file=sys.stderr)


def sh(*cmd, check=True, cwd=ROOT):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def rebuild():
    """Rerun the data pipeline. Returns a note string ('' when everything worked)."""
    py = sys.executable
    if os.environ.get("APPLY_TRADE_SKIP_BUILD") == "1":  # tests only
        return ""
    r = subprocess.run([py, "scripts/build_data.py", "--force"], cwd=ROOT, text=True, capture_output=True)
    print(r.stdout, r.stderr, flush=True)
    if r.returncode != 0:
        return ("Prices could not be fetched just now, so the dashboard numbers will catch up on the next "
                "scheduled update (holdings are already saved).")
    for s in ("history_csv.py", "current_csv.py", "intraday_csv.py", "build_standalone.py"):
        subprocess.run([py, f"scripts/{s}"], cwd=ROOT, check=True)
    return ""


def table(before, after):
    keys = list(dict.fromkeys(list(before) + list(after)))
    rows = [k for k in keys if before.get(k) != after.get(k)]
    if not rows:
        return "_No change to holdings._"
    out = ["| | Before | After |", "|---|---|---|"]
    for k in rows:
        out.append(f"| {k} | {before.get(k, '—')} | {after.get(k, '—')} |")
    return "\n".join(out)


def gh_comment_close(repo, num, body, reason):
    subprocess.run(["gh", "issue", "comment", str(num), "-R", repo, "--body", body], check=True)
    subprocess.run(["gh", "issue", "close", str(num), "-R", repo, "--reason", reason], check=False)


def ci(event_path):
    ev = load(event_path, {})
    issue = ev.get("issue") or {}
    num, author = issue.get("number"), (issue.get("user") or {}).get("login")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    url = issue.get("html_url")
    if author != OWNER:
        print(f"issue #{num} author {author!r} is not {OWNER}; not applying")
        return 0
    today = datetime.now(ET).date()
    try:
        txn = parse_body(issue.get("body"))
    except TradeError as e:
        gh_comment_close(repo, num, f"**Not applied.** {e}\n\nHoldings were not changed.", "not planned")
        return 0

    sh("git", "config", "user.name", "github-actions[bot]")
    sh("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    hp, tp = os.path.join(ROOT, "data", "holdings.json"), os.path.join(ROOT, "data", "transactions.json")
    for attempt in range(1, 6):
        sh("git", "fetch", "origin", "main")
        sh("git", "reset", "--hard", "origin/main")
        txns = load(tp, [])
        if any(x.get("issue") == num for x in txns):
            print(f"issue #{num} already applied; nothing to do")
            return 0
        H = load(hp, None)
        if H is None:
            gh_comment_close(repo, num, "**Not applied.** data/holdings.json is missing or invalid.", "not planned")
            return 1
        try:
            newH, rec = apply_transaction(H, txn, today=today, check=online_check if attempt == 1 else None)
        except TradeError as e:
            gh_comment_close(repo, num, f"**Not applied.** {e}\n\nHoldings were not changed. Fix the details and "
                                        f"submit a new trade from the site's Edit form.\n\n<sub>Submitted JSON: "
                                        f"`{json.dumps(txn)}`</sub>", "not planned")
            return 0
        stamp = datetime.now(ET).strftime("%Y-%m-%d %H:%M:%S ET")
        rec = {"id": f"T{num}", **rec, "issue": num, "issue_url": url, "applied_at_et": stamp}
        dump(hp, newH)
        dump(tp, txns + [rec])
        note = rebuild()
        sh("git", "add", "data", "dist")
        sh("git", "commit", "-m", f"trade: {rec['description']} (#{num})")
        p = sh("git", "push", "origin", "HEAD:main", check=False)
        if p.returncode == 0:
            break
        print(f"push failed (attempt {attempt}): {p.stderr.strip()}; retrying from origin/main", flush=True)
    else:
        subprocess.run(["gh", "issue", "comment", str(num), "-R", repo, "--body",
                        "**Not applied.** Could not push the update after 5 tries (other updates kept landing). "
                        "Re-add the `trade` label to retry."], check=False)
        return 1
    sha = sh("git", "rev-parse", "--short", "HEAD").stdout.strip()
    port = load(os.path.join(ROOT, "data", "portfolio.json"), {})
    total = (port.get("account") or {}).get("total")
    lines = [f"**Applied:** {rec['description']} (trade date {rec['date']})", "",
             table(summarize(H), summarize(newH)), ""]
    if rec.get("realized_pl") is not None:
        lines.append(f"Realized P/L: {'+' if rec['realized_pl'] >= 0 else '-'}${abs(rec['realized_pl']):,.2f}")
    if rec.get("fees"):
        lines.append(f"Fees: ${rec['fees']:,.2f}")
    if total is not None and not note:
        lines.append(f"Account value now: ${total:,.2f} (as of {port.get('generated_at_et')})")
    if note:
        lines.append(note)
    lines += ["", f"Saved in commit {sha}. The site shows it within a minute or two (after GitHub Pages rebuilds)."]
    gh_comment_close(repo, num, "\n".join(lines), "completed")
    return 0


def local(args):
    ddir = args.data_dir or os.path.join(ROOT, "data")
    hp, tp = os.path.join(ddir, "holdings.json"), os.path.join(ddir, "transactions.json")
    txn = load(args.txn, None)
    if txn is None:
        sys.exit(f"cannot read {args.txn}")
    H = load(hp, None)
    try:
        newH, rec = apply_transaction(H, txn, today=date.today(), check=online_check if args.online else None)
    except TradeError as e:
        print(f"NOT APPLIED: {e}")
        return 2
    print(rec["description"])
    print(table(summarize(H), summarize(newH)))
    if not args.dry_run:
        stamp = datetime.now(ET).strftime("%Y-%m-%d %H:%M:%S ET")
        txns = load(tp, [])
        dump(hp, newH)
        dump(tp, txns + [{"id": f"L{int(datetime.now().timestamp())}", **rec, "applied_at_et": stamp, "source": "manual"}])
        print("saved")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event")
    ap.add_argument("--txn")
    ap.add_argument("--data-dir")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--online", action="store_true", help="local mode: check symbols with Yahoo")
    a = ap.parse_args()
    if a.event:
        return ci(a.event)
    if a.txn:
        return local(a)
    ap.error("give --event or --txn")


if __name__ == "__main__":
    sys.exit(main())
