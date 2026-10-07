# iPhone Home Screen widget (Scriptable)

Live portfolio numbers on the Home Screen without an App Store app. The widget runs **on the phone** and loads:

`https://at4engineer.github.io/pq-22e56fd9/data/portfolio.json`

Tap opens the site: `https://at4engineer.github.io/pq-22e56fd9/`

School Chromebooks often block GitHub; this path is fine because Scriptable fetches from the phone’s network (cellular or home Wi‑Fi).

## Setup (about 2 minutes)

1. On the iPhone, install **Scriptable** (free) from the App Store.
2. Open Scriptable → tap **+** → name it e.g. `Portfolio`.
3. Delete any sample code. Paste the full contents of [`scriptable-portfolio.js`](./scriptable-portfolio.js).
4. Tap **Done** (or the play button once to preview).
5. Home Screen → long-press empty space → **Edit** → **Add Widget** → search **Scriptable**.
6. Pick **Small**, **Medium**, or **Large** → **Add Widget**.
7. Long-press the new widget → **Edit Widget** → **Script** → choose `Portfolio`. Leave “When Interacting” as Open URL / Run Script (tap opens the site via `widget.url`).
8. Optional Lock Screen (iOS 16+): Customize Lock Screen → Add Widget → Scriptable → circular / rectangular / inline → same script.

## What each size shows

Data is never invented. On fetch failure the last good JSON is shown from Keychain / Documents cache with a **stale** hint; if there is no cache, an error line appears.

| Size | Content |
|------|---------|
| **Small** | Total + day $/%%; UPRO price & %%; short-call mark/liability (or cash); quotes-as-of |
| **Medium** | Total + day change + market label; rows for UPRO, SPCX, short call mark/liability, cash |
| **Large** | Same as medium (more space for rows) + one-line covered-call note (e.g. UPRO vs $154 strike, days to Oct 16, ITM/OTM) when an option is still open |
| **Lock Screen** | Compact total and day change (circular / rectangular / inline) |

Colors match iOS Stocks dark: background `#1c1c1e`, green `#30d158`, red `#ff453a`, system fonts.

## Preview (desktop QA)

Open [`preview.html`](./preview.html) in a browser (or after Pages deploy: `/widgets/preview.html`) for static mockups of small / medium / large. Screenshots: `/workspace/pq-screens/widget-small.png` etc. on the build box.

## Refresh

iOS controls widget refresh timing. The script sets `refreshAfterDate` ~15 minutes; actual updates may be slower when the phone is idle. Opening Scriptable and running the script forces a fresh fetch and updates the cache.
