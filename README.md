# Portfolio Tracker

A plain, professional dashboard for a small portfolio, built as a fully static site:
plain HTML + CSS + JavaScript, no build step, no frameworks, no CDNs, no web fonts. It works on
locked-down school Chromebooks / Windows browsers and on phones (light or dark, following the
device setting).

All numbers come from `data/portfolio.json`, which `scripts/build_data.py` computes from real
quotes (Yahoo Finance via `yfinance`). Nothing is made up: if quotes cannot be fetched the script
fails and leaves the last good data in place.

**Tracking only. Not financial advice. Quotes may be delayed ~15 minutes.**

## Views

The page has four tabs (hash routes, so the browser Back button works):

| Tab | Contents |
|---|---|
| **Stocks** (`#stocks`, default on phones) | iOS Stocks-style list: account value + day change on top; one row per holding (stocks and the short option) and per watchlist symbol with name, intraday sparkline, price and a change box. Tap the change box to cycle day change %, day change $ and market value (market cap for watchlist symbols). Tap a row for the detail panel (`#stocks/<SYMBOL>`; a full-screen sheet on phones, a side panel on wide screens): price chart with 1D / 1W / 1M / 3M / 1Y / ALL, hover/touch crosshair with exact time and value, stats (open, high, low, prev close, 52-week high/low, volume, market cap or net assets) and your position (shares, avg cost, market value, day gain, unrealized P/L). Below the list: account value chart with the same ranges. |
| **Overview** (`#overview`, default on wide screens) | The original dashboard (summary, positions table, covered call, daily history, paper trading) |
| **Transactions** (`#transactions`) | Everything recorded through the Edit form, newest first (`data/transactions.json`) |
| **Edit** (`#edit`) | Form to record a trade; opens a prefilled GitHub issue that a workflow applies (see below) |

Everything refreshes every 60 s without reloading (the data itself changes when the update workflow runs).

## Look and motion

- Always dark (iOS Stocks palette): black background, #1c1c1e cards, #2c2c2e separators, white / #8e8e93 text,
  green #30d158 and red #ff453a. The status bar is black-translucent when installed on a phone.
- Phones (700 px wide or less): large title that collapses into a compact bar on scroll, bottom tab bar
  (Stocks, Overview, Transactions, Edit), bottom-sheet detail (swipe down or tap outside to close),
  pull to refresh (re-fetches the data now), and skeleton placeholders sized like the real content.
- Animations are plain CSS plus requestAnimationFrame, with no libraries: totals and prices count to the new
  value on refresh and briefly tint green or red, sparklines and charts draw left to right, chart ranges
  morph into each other, rows fade in on first load, the range control and tabs slide, buttons scale when
  pressed and the crosshair glides. All of it is switched off when the system setting "Reduce motion" is on.

## Editing the portfolio from the site

A static site can't save anything, so the Edit form goes through a GitHub issue:

1. Pick a type (Buy, Sell, Sell to open option, Buy to close option, Option expired, Option assigned, Deposit,
   Withdraw, Dividend, Set cash, Set cost basis, Watchlist add/remove) and fill in the fields.
2. **Continue on GitHub** opens `github.com/AT4Engineer/pq-22e56fd9/issues/new` with title `trade: ...`, label
   `trade` and the transaction as a fenced JSON block in the body. Tap **Submit new issue** (signed in as AT4Engineer).
3. `.github/workflows/apply-trade.yml` runs on issues opened/labeled `trade` **whose author is AT4Engineer**
   (others are ignored; a `trade` label on someone else's issue gets a refusal comment). It runs
   `scripts/apply_trade.py`, which validates the JSON (`scripts/trade_logic.py`), applies it to
   `data/holdings.json`, appends `data/transactions.json`, reruns `build_data.py` and the CSV/standalone scripts,
   commits, comments a before/after table on the issue and closes it.
4. On a validation error (e.g. selling more than you hold, an uncovered call, not enough cash, unknown symbol)
   it comments the reason, closes the issue as "not planned" and changes nothing.

Cash rules: buys and buy-to-close subtract `qty x price x multiplier + fees`; sells and sell-to-open add
`qty x price x multiplier - fees` (multiplier 100 for options); assignment of a covered call removes 100 shares
per contract and adds `strike x 100`; expiry just removes the option. Buys keep a weighted average cost (fees
included); sells report realized P/L when the average cost is known. Run the tests with
`python -m unittest discover -s tests -v` (they never touch the real holdings).

Local (no GitHub) equivalent: `python scripts/apply_trade.py --txn trade.json [--dry-run]`.

## What's on the Overview tab

| Section | Contents |
|---|---|
| Summary | Total account value, day change ($ and %), cash, short call liability |
| Positions | Symbol, name, qty, price, market value, day $, day %, % of portfolio (stocks, the short call, cash, total) |
| Covered call | Plain-language assignment outcome, mark, bid/ask, liability, underlying vs strike and distance, in/out of the money, days to expiry, intrinsic/time value |
| Account value history | Plain line chart, one point per trading day |
| Paper trading | SPY trend strategy vs buy-and-hold (simulation): values, returns, readiness criteria met X of 7 |
| Footer | Last updated time (ET), data-delay note, caveats |

Green/red is used only for gains and losses.

Account value = stocks + cash - current value of the short option (a liability).

## Layout

```
index.html                  page shell
assets/style.css            styles (light/dark, responsive)
assets/app.js               rendering, auto-refresh every 60 s (no full reload)
assets/favicon.svg
data/holdings.json          positions, cash, avg costs, watchlist (updated by the Edit flow, or by hand)
data/transactions.json      every transaction applied from an issue
data/charts/<SYMBOL>.json   precomputed price charts per symbol (1D 5m, 1W 30m, then daily) + _account.json
data/intraday.json          account value every minute of the session, rolling 7 trading days (+ intraday.csv)
data/option_marks.json      option bid/ask marks recorded on each regular-session run
data/history.json           one point per trading day (appended/updated by the script)
data/paper.json             snapshot of the SPY paper lab
data/portfolio.json         the single file the page loads
data/option_state.json      last good option bid/ask mid per contract (session date + timestamp)
dist/dashboard.html         single self-contained offline file (CSS/JS/data inline)
scripts/build_data.py       builds data/portfolio.json from live quotes
scripts/history_csv.py      writes data/history.csv (for Google Sheets IMPORTDATA)
scripts/current_csv.py      writes data/current.csv (per-holding price/mark, source, value, as-of; for Sheets IMPORTDATA)
scripts/intraday_csv.py     writes data/intraday.csv (minute account values, for Sheets IMPORTDATA)
scripts/charts.py           chart helpers used by build_data.py
scripts/trade_logic.py      validation + holdings math for transactions (pure functions)
scripts/apply_trade.py      applies a trade issue (CI) or a local JSON file
scripts/build_standalone.py builds dist/dashboard.html
tests/test_apply_trade.py   unit tests for every transaction type + the CI flow (fake git remote and gh)
.github/workflows/update.yml scheduled data refresh
.github/workflows/apply-trade.yml applies "trade" issues
```

## Run locally

```bash
pip install yfinance pandas
python scripts/build_data.py          # refresh data/portfolio.json (+ history, paper snapshot)
python scripts/build_standalone.py    # refresh dist/dashboard.html
python -m http.server 8000            # then open http://localhost:8000
```

Opening `index.html` straight from disk will not load data (browsers block `fetch` on `file://`);
use the local server, GitHub Pages, or the standalone file.

`build_data.py --force` rewrites the files even if no price changed (normally it skips writing
when nothing but the timestamp would change, to avoid empty commits; the option odds and days-to-expiry still change over time).

The paper-lab panel is rebuilt from a sibling `../spy-paper-lab` folder when it exists (or
`PAPER_LAB_DIR`); otherwise the saved `data/paper.json` snapshot is used.

## Standalone offline file

`dist/dashboard.html` is one file with everything inline and the latest data embedded, so it works
with no network (for example downloaded from an email and opened in a browser). It shows
"Offline snapshot as of ..." at the top.

```bash
python scripts/build_standalone.py --refresh     # fetch fresh quotes, then build
python scripts/build_standalone.py --remote-url https://<user>.github.io/<repo>/data/portfolio.json
```

With `--remote-url` (or `DASHBOARD_REMOTE_URL`) the file also tries every 60 s to load newer data
from that URL and silently keeps the embedded snapshot if it can't. Without it, the file makes no
network requests at all. Note: email previews (e.g. Gmail's viewer) don't run JavaScript, so
download the attachment and open it in the browser.

## Publish on GitHub Pages

1. Push this repo to GitHub (public repos get Pages for free).
2. Settings > Pages > Build and deployment: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Settings > Actions > General > Workflow permissions: allow read and write (the workflow also
   declares `contents: write`).
4. Actions tab > "Update portfolio data" > Run workflow, to test it once.

### Update schedule (UTC)

```
*/15 13-20 * * 1-5   every 15 min, 13:00-20:45 UTC, Mon-Fri (market hours)
10 21 * * 1-5        once after the close (17:10 EDT / 16:10 EST)
```

Each run commits `data/` and `dist/` only if something changed.

## Minute-by-minute account value

Each run of `build_data.py` rebuilds the session's account value per minute from Yahoo 1-minute bars
(`interval=1m`, last 7 days) for every stock, using the quantities held at that run, plus cash, plus the
option's value (negative for the short call). Minutes already stored are kept as recorded; each run adds every
minute since the previous one, so although the page only changes as often as the workflow runs (~15 min), no
minute is skipped. The option contract trades thinly, so its per-minute value is the latest known price at or
before that minute: a bid/ask mark recorded by this tracker (held constant between runs), a Yahoo 1-minute trade
print, or the previous day's mark. Expect small steps in the line when a new mark is recorded.
`data/intraday.csv` has the same rows for Google Sheets:
`=IMPORTDATA("https://at4engineer.github.io/pq-22e56fd9/data/intraday.csv")`.

## Caveats

- GitHub's scheduled workflows are best-effort: runs are often delayed 5-30+ minutes, can be
  skipped under load, and are automatically disabled after 60 days without repository activity
  (the data commits normally count as activity).
- Yahoo Finance data via `yfinance` is free and unofficial; it may be delayed, may rate-limit
  cloud IPs, and can break when Yahoo changes things. A failed run leaves the last good data.
- Holiday closures are not special-cased; on those days the data simply doesn't change.
- Option marks use the bid/ask midpoint (or last trade, or intrinsic value as a fallback); wide
  spreads make that approximate. Outside market hours Yahoo often reports no bid/ask; the script then
  reuses the last good bid/ask mid saved in `data/option_state.json` (never the last trade), and an
  off-hours run never overwrites a session's history row recorded with live bid/ask quotes. Assignment risk and the market-implied chance are rough guides, not forecasts.
- A public repository makes the holdings and values visible to anyone with the link, and trade issues
  (amounts, prices, notes) are public too.
- 1W charts and the account 1D/1W lines value the current holdings; the account history is only as long as
  this tracker has been running (1M+ ranges fill in day by day).

## Install on a phone (PWA)

The hosted site ships `manifest.webmanifest` ("Portfolio Tracker" / "Portfolio", standalone),
PNG icons (`assets/icons/`), Apple home-screen meta tags and a small service worker (`sw.js`).
The service worker caches the app shell for offline launch but always fetches `data/portfolio.json`
network-first (cached copy only when offline). iPhone: open the Pages URL in Safari > Share >
Add to Home Screen. Android: Chrome menu > Install app / Add to Home screen.
Bump `CACHE` in `sw.js` when changing shell files to force a refresh. The standalone
`dist/dashboard.html` build strips these PWA tags automatically.
