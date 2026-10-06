# Portfolio Tracker

A plain, professional dashboard for a small portfolio, built as a fully static site:
plain HTML + CSS + JavaScript, no build step, no frameworks, no CDNs, no web fonts. It works on
locked-down school Chromebooks / Windows browsers and on phones (light or dark, following the
device setting).

All numbers come from `data/portfolio.json`, which `scripts/build_data.py` computes from real
quotes (Yahoo Finance via `yfinance`). Nothing is made up: if quotes cannot be fetched the script
fails and leaves the last good data in place.

**Tracking only. Not financial advice. Quotes may be delayed ~15 minutes.**

## What's on the screen

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
data/holdings.json          positions (edit this when you trade)
data/history.json           one point per trading day (appended/updated by the script)
data/paper.json             snapshot of the SPY paper lab
data/portfolio.json         the single file the page loads
dist/dashboard.html         single self-contained offline file (CSS/JS/data inline)
scripts/build_data.py       builds data/portfolio.json from live quotes
scripts/history_csv.py      writes data/history.csv (for Google Sheets IMPORTDATA)
scripts/build_standalone.py builds dist/dashboard.html
.github/workflows/update.yml scheduled data refresh
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

## Caveats

- GitHub's scheduled workflows are best-effort: runs are often delayed 5-30+ minutes, can be
  skipped under load, and are automatically disabled after 60 days without repository activity
  (the data commits normally count as activity).
- Yahoo Finance data via `yfinance` is free and unofficial; it may be delayed, may rate-limit
  cloud IPs, and can break when Yahoo changes things. A failed run leaves the last good data.
- Holiday closures are not special-cased; on those days the data simply doesn't change.
- Option marks use the bid/ask midpoint (or last trade, or intrinsic value as a fallback); wide
  spreads make that approximate. Outside market hours Yahoo often reports no bid/ask, so the mark
  falls back to the last trade. Assignment risk and the market-implied chance are rough guides, not forecasts.
- A public repository makes the holdings and values visible to anyone with the link.

## Install on a phone (PWA)

The hosted site ships `manifest.webmanifest` ("Portfolio Tracker" / "Portfolio", standalone),
PNG icons (`assets/icons/`), Apple home-screen meta tags and a small service worker (`sw.js`).
The service worker caches the app shell for offline launch but always fetches `data/portfolio.json`
network-first (cached copy only when offline). iPhone: open the Pages URL in Safari > Share >
Add to Home Screen. Android: Chrome menu > Install app / Add to Home screen.
Bump `CACHE` in `sw.js` when changing shell files to force a refresh. The standalone
`dist/dashboard.html` build strips these PWA tags automatically.
