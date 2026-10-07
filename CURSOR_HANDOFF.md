# Cursor handoff — Portfolio Tracker (Anderson Tarpley)

**Repo:** https://github.com/AT4Engineer/pq-22e56fd9 (public)  
**Live site:** https://at4engineer.github.io/pq-22e56fd9/  
**Display (2nd monitor):** https://at4engineer.github.io/pq-22e56fd9/display.html  
**Local clone (this box):** `/workspace/portfolio-dashboard`  
**iPhone widget (Scriptable):** `widgets/` — paste `widgets/scriptable-portfolio.js` into Scriptable; setup in `widgets/README.md`.  
**Box tracker (separate):** `/workspace/portfolio`  
**Paper lab (hidden, keep on disk):** `/workspace/spy-paper-lab` — do **not** surface in UI

Owner: Anderson Tarpley · Gmail: at4engineer@gmail.com · Brokerage: E\*Trade · TZ: America/New_York  
**Never place real trades.** He logs trades himself (Edit form or by messaging Grok Bot).

---

## What this is

Static GitHub Pages PWA (plain HTML/CSS/JS, no framework). Quotes via `yfinance` in GitHub Actions. School Chromebook may block GitHub; phone + emailed offline HTML are the school-safe paths.

**Style (non-negotiable):** always dark, iOS Stocks look, subtle CSS animations, `prefers-reduced-motion` respected, **plain financial wording — no game/XP/boss/badge language.**

---

## Current holdings (`data/holdings.json`)

- 4 SPCX, 100 UPRO, short 1 UPRO Oct 16 2026 **$154** call (covered), cash **$964.70**
- Watchlist: empty or whatever is in the file
- `projection.birthdate`: **"2008-11-25"** (age 17; turns 18 Nov 25 2026; 59½ ≈ May 2068)
- Original call **premium received: not set** — Edit → “Set option premium received”

Oct 6 2026 close total was about **$16,848**. Account value = stocks + cash − short-option mark.

---

## Tabs / pages

| Route | File / view | Purpose |
|---|---|---|
| `#stocks` | `index.html` | Apple Stocks–style list + detail sheets + charts |
| `#overview` | `index.html` | Summary, positions, **Monthly roll plan**, history |
| `#projections` | `index.html` + `assets/projection.js` | Retirement-style FV to age 59.5 (Ramsey monthly compound math); monthly contrib vs $0 |
| `#transactions` | `index.html` | From `data/transactions.json` |
| `#edit` | `index.html` | Opens GitHub issue → `apply-trade.yml` |
| `display.html` | + `assets/display.js/css` | Kiosk: total + charts only (no edit/roll text) |
| `dist/dashboard.html` | built by `build_standalone.py` | Offline email snapshot |
| `widgets/` | Scriptable + preview | iPhone Home/Lock Screen live portfolio widget |

Bottom tab order: Stocks · Overview · **Projections** · Transactions · Edit

---

## Covered-call plan (his words)

If UPRO > $154 near expiry → **buy to close before 4:00 PM ET Fri Oct 16** to keep shares → sell **Nov 20 2026** monthly call ATM (nearest strike to price) → pocket premium → repeat.  
Reminders: routine “Oct 16 covered call buyback reminder” at 10:14 AM ET that day.

Roll UI: Overview “Monthly roll plan”, option detail, Edit types **Roll** and **Set option premium received**. Data: `scripts/roll_plan.py`, `data/roll.csv`, `data/roll_state.json`.

---

## Key files to edit

```
index.html                 shell + tab markup
display.html               second-monitor page
assets/app.js              main UI (~1.7k+ lines)
assets/projection.js       projection math (client-side)
assets/style.css           dark Stocks theme
assets/display.js/css
sw.js                      bump CACHE on shell changes (was v7 after roll)
data/holdings.json         source of truth for positions
data/transactions.json
scripts/build_data.py      quotes → portfolio.json, charts, option marks
scripts/roll_plan.py / roll_csv.py
scripts/trade_logic.py / apply_trade.py
scripts/build_standalone.py
scripts/history_csv.py / current_csv.py / intraday_csv.py
.github/workflows/update.yml       ~15m market hours + after close
.github/workflows/apply-trade.yml  issues labeled trade by AT4Engineer
tests/                     unittest + projection.test.js
```

Generated (workflow overwrites): `data/portfolio.json`, `history.*`, `intraday.*`, `current.csv`, `roll.csv`, `charts/*`, `dist/dashboard.html`

---

## Box-only helpers (not in repo)

| Path | Role |
|---|---|
| `/workspace/portfolio/` | Local loop (`loop.py`, `.venv`) writing CSV/TSV/MD for Sheets paste |
| `/workspace/portfolio-dashboard-kick.sh` | Triggers GH Actions every ~15m (schedule is flaky) |
| `/workspace/pq-screens/` | Mobile/desktop screenshots |
| Grok Bot routines | Nightly 4:46 PM ET email of `dist/dashboard.html` to at4engineer@gmail.com; Oct 16 buyback reminder |

---

## Google Sheet (private)

https://docs.google.com/spreadsheets/d/1qWvfD4cfqeJF9BDkjG1FvlOTVEGiNQITxvhZspSYHkM/edit  
Tabs: Summary (dark; Next roll rows via IMPORTDATA `roll.csv`), History (`history.csv`), Live (GOOGLEFINANCE + option from `current.csv`).  
Title may still say “Portfolio Quest” — user renames. Chart chart backgrounds may still be light (API can’t fix).

CSV URLs:
- https://at4engineer.github.io/pq-22e56fd9/data/history.csv
- https://at4engineer.github.io/pq-22e56fd9/data/current.csv
- https://at4engineer.github.io/pq-22e56fd9/data/intraday.csv
- https://at4engineer.github.io/pq-22e56fd9/data/roll.csv

---

## Local commands

```bash
cd /workspace/portfolio-dashboard
git pull --rebase
pip install -r scripts/requirements.txt   # yfinance pandas
python scripts/build_data.py
python scripts/build_standalone.py --refresh
python -m unittest discover -s tests -v
python -m http.server 8000   # open http://localhost:8000
```

Edit holdings → commit/push `data/holdings.json`, or use Edit form / `python scripts/apply_trade.py --txn trade.json`.

`gh` on this box is logged in as **AT4Engineer**.

---

## Constraints for Cursor

1. No game language. Always dark + animations + reduced-motion.
2. Never invent prices — fail closed or keep last good mark (`option_state.json`).
3. Short option: price up = his loss (red).
4. Chart drag: `touch-action: none` + `preventDefault` (passive:false); don’t scroll the page.
5. Public site: no real name on the page; URL is the obscurity.
6. School: don’t rely on GitHub loading on school PC; phone + Gmail HTML OK.
7. UPRO is 3x — Projections tab uses **broad-market** 6/8/10% presets, not 3x (caveat already in UI).

---

## Recently finished (2026-10-06)

- **Projections = Ramsey compound model** (monthly rate = annual/12, end-of-month deposits; presets 8/10/12% with 12% Ramsey default; Jack $36,635 test)
- **Scriptable iPhone widget** (`widgets/scriptable-portfolio.js` + README + preview)
- Removed paper trading from UI (`2fc1b70`); `/workspace/spy-paper-lab` kept on disk
- `display.html` kiosk page
- Chart drag scroll fix
- Monthly roll plan + Roll / Set-premium Edit types (`f77e372`, `abda1e3`)
- **Projections tab** with birthdate 2008-11-25 (`7819eb7`) — rates from Damodaran/S&P history; today’s vs future $; canvas chart; milestones

## Likely unfinished / verify

- Google Sheet **Projections** tab (FV formulas) — may not exist yet
- Fresh screenshot `/workspace/pq-screens/projections-mobile.png` after age default
- Nightly routine prompt still accurate after Projections/roll changes
- README still mentions paper trading / light theme in places — refresh if editing docs

---

## Next feature he asked for (status)

Projections tab: **implemented on site** with age from birthdate, monthly contribution chips, keep-investing vs add-nothing, value at 59.5. Confirm live, then polish Sheet/email if needed.
