// Portfolio Widget — Scriptable
// Live data: https://at4engineer.github.io/pq-22e56fd9/data/portfolio.json
// Site:     https://at4engineer.github.io/pq-22e56fd9/
//
// Paste into Scriptable → Add Script → paste this file.
// Home Screen: long-press → Widget → Scriptable → choose this script + size.
// Lock Screen (iOS 16+): accessoryCircular / accessoryRectangular / accessoryInline.

const DATA_URL = "https://at4engineer.github.io/pq-22e56fd9/data/portfolio.json"
const SITE_URL = "https://at4engineer.github.io/pq-22e56fd9/"
const CACHE_KEY = "pq22_portfolio_json"
const CACHE_FILE = "pq22-portfolio-cache.json"
const FETCH_TIMEOUT_MS = 12000

const BG = new Color("#1c1c1e")
const BG_DEEP = new Color("#000000")
const LABEL = new Color("#8e8e93")
const WHITE = Color.white()
const GREEN = new Color("#30d158")
const RED = new Color("#ff453a")
const DIVIDER = new Color("#38383a")

// ─── Data ───────────────────────────────────────────────────────────

async function fetchPortfolio() {
  const req = new Request(DATA_URL)
  req.timeoutInterval = FETCH_TIMEOUT_MS / 1000
  const json = await req.loadJSON()
  if (!json || !json.account) throw new Error("Invalid portfolio JSON")
  saveCache(json)
  return json
}

function saveCache(json) {
  const text = JSON.stringify(json)
  try {
    Keychain.set(CACHE_KEY, text)
  } catch (_) {}
  try {
    const fm = FileManager.local()
    const path = fm.joinPath(fm.documentsDirectory(), CACHE_FILE)
    fm.writeString(path, text)
  } catch (_) {}
}

function loadCache() {
  try {
    if (Keychain.contains(CACHE_KEY)) {
      return JSON.parse(Keychain.get(CACHE_KEY))
    }
  } catch (_) {}
  try {
    const fm = FileManager.local()
    const path = fm.joinPath(fm.documentsDirectory(), CACHE_FILE)
    if (fm.fileExists(path)) {
      return JSON.parse(fm.readString(path))
    }
  } catch (_) {}
  return null
}

// ─── Widget builders ────────────────────────────────────────────────

async function buildWidget(data, fam, isStale, err) {
  if (fam.indexOf("accessory") === 0) {
    return buildAccessory(data, fam, isStale, err)
  }
  if (!data) return buildErrorWidget(err || "No data")
  if (fam === "small") return buildSmall(data, isStale)
  if (fam === "large") return buildLarge(data, isStale)
  return buildMedium(data, isStale)
}

function buildErrorWidget(msg) {
  const w = new ListWidget()
  w.backgroundColor = BG
  w.setPadding(12, 14, 12, 14)
  w.url = SITE_URL
  const t = w.addText("Portfolio")
  t.font = Font.boldSystemFont(13)
  t.textColor = WHITE
  w.addSpacer(6)
  const e = w.addText(msg || "Unable to load")
  e.font = Font.systemFont(12)
  e.textColor = RED
  e.lineLimit = 4
  return w
}

function buildSmall(data, isStale) {
  const w = new ListWidget()
  styleHome(w, 10, 12)
  const acct = data.account

  const titleRow = w.addStack()
  titleRow.layoutHorizontally()
  titleRow.centerAlignContent()
  const title = titleRow.addText("Portfolio" + (isStale ? " · stale" : ""))
  title.font = Font.systemFont(11)
  title.textColor = LABEL
  titleRow.addSpacer()
  const mkt = titleRow.addText(shortMarketLabel(data))
  mkt.font = Font.systemFont(9)
  mkt.textColor = LABEL
  mkt.lineLimit = 1

  w.addSpacer(3)

  const total = w.addText(fmtMoney(acct.total))
  total.font = Font.boldSystemFont(20)
  total.textColor = WHITE
  total.minimumScaleFactor = 0.65
  total.lineLimit = 1

  const ch = w.addText(fmtDayChange(acct.day_change, acct.day_change_pct))
  ch.font = Font.boldSystemFont(12)
  ch.textColor = changeColor(acct.day_change)
  ch.minimumScaleFactor = 0.7
  ch.lineLimit = 1

  w.addSpacer(6)

  // Top holding (prefer UPRO) — price + day change
  const upro = findPosition(data, "UPRO") || (data.positions && data.positions[0])
  if (upro) {
    const row = w.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    const sym = row.addText(upro.symbol)
    sym.font = Font.boldSystemFont(11)
    sym.textColor = WHITE
    row.addSpacer()
    const px = row.addText(fmtPrice(upro.price))
    px.font = Font.systemFont(11)
    px.textColor = WHITE
    const pct = row.addText("  " + fmtSignedPct(upro.day_change_pct))
    pct.font = Font.systemFont(11)
    pct.textColor = changeColor(upro.day_change_pct)
  }

  w.addSpacer(3)

  // One-liner: open short call mark, else cash
  const opt = ((data.options || []).filter((o) => !o.expired)[0]) || null
  let line = ""
  if (opt) {
    const strike = opt.strike != null ? trimNum(opt.strike) : "?"
    line =
      (opt.underlying || "OPT") +
      " $" +
      strike +
      "C  " +
      fmtPrice(opt.mark != null ? opt.mark : opt.last) +
      "  " +
      fmtMoney(opt.liability)
  } else if (acct.cash != null) {
    line = "Cash  " + fmtMoney(acct.cash)
  }
  if (line) {
    const note = w.addText(line)
    note.font = Font.systemFont(10)
    note.textColor = LABEL
    note.lineLimit = 1
    note.minimumScaleFactor = 0.75
  }

  w.addSpacer()

  addFooter(w, data, false, 9) // stale already in title
  return w
}

function findPosition(data, symbol) {
  const list = data.positions || []
  for (let i = 0; i < list.length; i++) {
    if (list[i].symbol === symbol) return list[i]
  }
  return null
}

function buildMedium(data, isStale) {
  const w = new ListWidget()
  styleHome(w, 12, 14)
  addHeader(w, data, isStale)
  w.addSpacer(8)
  addHoldingRows(w, data, 4)
  return w
}

function buildLarge(data, isStale) {
  const w = new ListWidget()
  styleHome(w, 14, 16)
  addHeader(w, data, isStale)
  w.addSpacer(10)
  addHoldingRows(w, data, 8)
  w.addSpacer(8)
  addCoveredCallNote(w, data)
  w.addSpacer()
  addFooter(w, data, isStale, 11)
  return w
}

function buildAccessory(data, fam, isStale, err) {
  const w = new ListWidget()
  w.url = SITE_URL
  if (typeof w.addAccessoryWidgetBackground !== "undefined") {
    w.addAccessoryWidgetBackground = true
  }

  if (!data) {
    const t = w.addText(err ? "Err" : "—")
    t.font = Font.systemFont(12)
    t.textColor = Color.white()
    return w
  }

  const acct = data.account
  const sign = acct.day_change >= 0 ? "+" : ""
  const staleMark = isStale ? " · stale" : ""

  if (fam === "accessorycircular") {
    const v = w.addText(fmtCompact(acct.total))
    v.font = Font.boldSystemFont(14)
    v.textColor = Color.white()
    v.centerAlignText()
    v.minimumScaleFactor = 0.6
    const c = w.addText(sign + fmtPct(acct.day_change_pct))
    c.font = Font.systemFont(11)
    c.textColor = changeColor(acct.day_change)
    c.centerAlignText()
    return w
  }

  if (fam === "accessoryinline") {
    const line =
      fmtCompact(acct.total) +
      "  " +
      sign +
      fmtMoney(acct.day_change) +
      " (" +
      sign +
      fmtPct(acct.day_change_pct) +
      ")" +
      staleMark
    const t = w.addText(line)
    t.font = Font.systemFont(12)
    t.textColor = Color.white()
    return w
  }

  // accessoryRectangular
  const title = w.addText("Portfolio" + staleMark)
  title.font = Font.systemFont(11)
  title.textColor = LABEL
  const total = w.addText(fmtMoney(acct.total))
  total.font = Font.boldSystemFont(16)
  total.textColor = Color.white()
  total.minimumScaleFactor = 0.7
  const ch = w.addText(fmtDayChange(acct.day_change, acct.day_change_pct))
  ch.font = Font.systemFont(12)
  ch.textColor = changeColor(acct.day_change)
  return w
}

// ─── Shared layout ──────────────────────────────────────────────────

function styleHome(w, padV, padH) {
  w.backgroundColor = BG
  w.setPadding(padV, padH, padV, padH)
  w.url = SITE_URL
  // Refresh hint ~15 min (iOS may throttle)
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000)
}

function addHeader(w, data, isStale) {
  const acct = data.account
  const top = w.addStack()
  top.layoutHorizontally()
  top.centerAlignContent()

  const left = top.addStack()
  left.layoutVertically()
  left.centerAlignContent()

  const title = left.addText("Portfolio" + (isStale ? " · stale" : ""))
  title.font = Font.systemFont(12)
  title.textColor = LABEL

  const total = left.addText(fmtMoney(acct.total))
  total.font = Font.boldSystemFont(26)
  total.textColor = WHITE
  total.minimumScaleFactor = 0.65
  total.lineLimit = 1

  top.addSpacer()

  const right = top.addStack()
  right.layoutVertically()
  right.centerAlignContent()

  const ch = right.addText(fmtDayChange(acct.day_change, acct.day_change_pct))
  ch.font = Font.boldSystemFont(14)
  ch.textColor = changeColor(acct.day_change)
  ch.rightAlignText()
  ch.minimumScaleFactor = 0.7
  ch.lineLimit = 2

  const mkt = right.addText(shortMarketLabel(data))
  mkt.font = Font.systemFont(10)
  mkt.textColor = LABEL
  mkt.rightAlignText()
}

function addHoldingRows(w, data, maxRows) {
  const rows = buildRows(data)
  const n = Math.min(rows.length, maxRows)
  for (let i = 0; i < n; i++) {
    addRow(w, rows[i])
    if (i < n - 1) w.addSpacer(5)
  }
}

function buildRows(data) {
  const rows = []
  const positions = (data.positions || []).slice()
  // Prefer UPRO then SPCX then others by value
  positions.sort((a, b) => {
    const order = { UPRO: 0, SPCX: 1 }
    const ao = order[a.symbol] != null ? order[a.symbol] : 9
    const bo = order[b.symbol] != null ? order[b.symbol] : 9
    if (ao !== bo) return ao - bo
    return (b.value || 0) - (a.value || 0)
  })
  for (const p of positions) {
    rows.push({
      symbol: p.symbol,
      detail: (p.shares != null ? String(p.shares) + " sh" : "") || p.name || "",
      price: p.price,
      change: p.day_change,
      changePct: p.day_change_pct,
      value: p.value,
      liability: false,
    })
  }
  const opts = data.options || []
  for (const o of opts) {
    if (o.expired) continue
    const label =
      (o.underlying || "OPT") +
      " " +
      (o.strike != null ? "$" + trimNum(o.strike) : "") +
      (o.type === "call" ? "C" : o.type === "put" ? "P" : "")
    const short = (o.position || "").toLowerCase() === "short"
    rows.push({
      symbol: label,
      detail: short ? "short call" : o.position || "option",
      price: o.mark != null ? o.mark : o.last,
      change: o.day_change,
      changePct: null,
      value: o.liability != null ? o.liability : null,
      liability: short,
    })
  }
  if (data.account && data.account.cash != null) {
    rows.push({
      symbol: "Cash",
      detail: "",
      price: null,
      change: null,
      changePct: null,
      value: data.account.cash,
      liability: false,
      isCash: true,
    })
  }
  return rows
}

function addRow(w, row) {
  const stack = w.addStack()
  stack.layoutHorizontally()
  stack.centerAlignContent()

  const left = stack.addStack()
  left.layoutVertically()
  left.centerAlignContent()

  const sym = left.addText(row.symbol)
  sym.font = Font.boldSystemFont(13)
  sym.textColor = WHITE
  sym.lineLimit = 1
  sym.minimumScaleFactor = 0.7

  if (row.detail) {
    const d = left.addText(row.detail)
    d.font = Font.systemFont(10)
    d.textColor = LABEL
    d.lineLimit = 1
  }

  stack.addSpacer()

  const mid = stack.addStack()
  mid.layoutVertically()
  mid.centerAlignContent()

  if (row.price != null) {
    const px = mid.addText(fmtPrice(row.price))
    px.font = Font.systemFont(12)
    px.textColor = WHITE
    px.rightAlignText()
  } else if (row.isCash) {
    const px = mid.addText("—")
    px.font = Font.systemFont(12)
    px.textColor = LABEL
    px.rightAlignText()
  }

  if (row.change != null) {
    // Short option: rising mark = loss (already signed in JSON as liability day_change)
    const c = mid.addText(fmtSignedMoney(row.change))
    c.font = Font.systemFont(11)
    c.textColor = changeColor(row.change)
    c.rightAlignText()
  }

  stack.addSpacer(10)

  const right = stack.addStack()
  right.layoutVertically()
  right.centerAlignContent()

  if (row.value != null) {
    const v = right.addText(fmtMoney(row.value))
    v.font = Font.boldSystemFont(13)
    v.textColor = row.liability ? RED : WHITE
    v.rightAlignText()
    v.minimumScaleFactor = 0.7
  }
  if (row.changePct != null) {
    const p = right.addText(fmtSignedPct(row.changePct))
    p.font = Font.systemFont(11)
    p.textColor = changeColor(row.changePct)
    p.rightAlignText()
  }
}

function addCoveredCallNote(w, data) {
  const opts = (data.options || []).filter((o) => !o.expired)
  if (!opts.length) return
  const o = opts[0]
  const strike = o.strike != null ? trimNum(o.strike) : "?"
  const under = o.underlying || "—"
  const spot = o.spot != null ? fmtPrice(o.spot) : "—"
  const dte = o.dte != null ? o.dte : "?"
  const exp = formatExpiryShort(o.expiry)
  const status = o.itm ? "ITM" : "OTM"
  const line =
    under +
    " " +
    spot +
    " vs $" +
    strike +
    " call · " +
    dte +
    "d to " +
    exp +
    " · " +
    status
  const t = w.addText(line)
  t.font = Font.systemFont(11)
  t.textColor = LABEL
  t.lineLimit = 2
  t.minimumScaleFactor = 0.8
}

function addFooter(w, data, isStale, size) {
  const bits = []
  if (data.quotes_as_of_et) bits.push(data.quotes_as_of_et)
  else if (data.generated_at_et) bits.push(data.generated_at_et)
  if (isStale) bits.push("stale")
  const t = w.addText(bits.join(" · ") || "")
  t.font = Font.systemFont(size || 10)
  t.textColor = LABEL
  t.lineLimit = 1
  t.minimumScaleFactor = 0.7
}

// ─── Formatters ─────────────────────────────────────────────────────

function changeColor(n) {
  if (n == null || isNaN(n)) return LABEL
  if (n > 0) return GREEN
  if (n < 0) return RED
  return LABEL
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—"
  const neg = n < 0
  const abs = Math.abs(n)
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return (neg ? "-$" : "$") + s
}

function fmtSignedMoney(n) {
  if (n == null || isNaN(n)) return "—"
  const sign = n > 0 ? "+" : n < 0 ? "-" : ""
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return sign + "$" + abs
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return "—"
  if (Math.abs(n) >= 100) {
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "—"
  return Math.abs(n).toFixed(2) + "%"
}

function fmtSignedPct(n) {
  if (n == null || isNaN(n)) return "—"
  const sign = n > 0 ? "+" : n < 0 ? "-" : ""
  return sign + Math.abs(n).toFixed(2) + "%"
}

function fmtDayChange(chg, pct) {
  return fmtSignedMoney(chg) + " (" + fmtSignedPct(pct) + ")"
}

function fmtCompact(n) {
  if (n == null || isNaN(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 1e6) return (n < 0 ? "-" : "") + "$" + (abs / 1e6).toFixed(2) + "M"
  if (abs >= 1000) return (n < 0 ? "-" : "") + "$" + (abs / 1000).toFixed(1) + "k"
  return fmtMoney(n)
}

function trimNum(n) {
  if (n == null || isNaN(n)) return "?"
  return Number.isInteger(n) ? String(n) : String(n)
}

function formatExpiryShort(iso) {
  if (!iso) return "?"
  // YYYY-MM-DD → "Oct 16"
  const parts = String(iso).split("-")
  if (parts.length < 3) return iso
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const m = months[parseInt(parts[1], 10) - 1] || parts[1]
  const d = String(parseInt(parts[2], 10))
  return m + " " + d
}

function shortMarketLabel(data) {
  if (data.market_label) {
    const s = String(data.market_label)
    if (s.length > 22) return s.slice(0, 20) + "…"
    return s
  }
  return data.market_state || ""
}

// ─── Main ────────────────────────────────────────────────────────────
const family = (config.widgetFamily || "medium").toLowerCase()

let payload = null
let stale = false
let errorMsg = null

try {
  payload = await fetchPortfolio()
} catch (e) {
  errorMsg = String(e)
  payload = loadCache()
  if (payload) stale = true
}

const widget = await buildWidget(payload, family, stale, errorMsg)
widget.url = SITE_URL
if (!config.runsInWidget) {
  if (family.indexOf("accessory") === 0) {
    if (family === "accessorycircular") await widget.presentAccessoryCircular()
    else if (family === "accessoryinline") await widget.presentAccessoryInline()
    else await widget.presentAccessoryRectangular()
  } else if (family === "small") {
    await widget.presentSmall()
  } else if (family === "large") {
    await widget.presentLarge()
  } else {
    await widget.presentMedium()
  }
}
Script.setWidget(widget)
Script.complete()

