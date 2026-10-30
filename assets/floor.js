/* Trading Floor tab (#floor): real, delayed quotes in a busy trading-floor layout.
 * Every price, change and % change comes from data/floor.json (written by scripts/floor_data.py from
 * Yahoo Finance, ~15 min delayed, every 15 min in market hours). Nothing is simulated or made up: a symbol
 * missing from the file is not shown. Tiles flash only when a value really changed between refreshes.
 * The offline dashboard.html carries a snapshot (window.PQ_FLOOR) labelled with its as-of time.
 * One requestAnimationFrame loop for the clock/flash; it only runs while the tab is on screen.
 */
(function () {
  "use strict";
  var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var PULSE = ["SPY", "QQQ", "DIA", "IWM", "VIX", "UPRO", "SPCX", "NVDA", "AAPL", "TSLA"];
  var REFRESH_MS = 60000;
  function $(id) { return document.getElementById(id); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function f2(x) { return isNum(x) ? x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }
  function sgn(x) { return isNum(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2) : "—"; }
  function big(n) { return !isNum(n) || n <= 0 ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  var ETHM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  var ETD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "2-digit", day: "2-digit", year: "numeric" });
  var ETMD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

  var S = { syms: [], by: {}, built: false, running: false, raf: 0, held: {}, sel: "UPRO", data: null, colors: null, timer: 0 };

  // ---------------------------------------------------------------- data
  // "As of" text: the close after the session, otherwise the last delayed bar's time.
  function asOfText(d, now) {
    if (!d || !isNum(d.as_of_epoch)) return d && d.generated_at_et ? "As of " + d.generated_at_et : "";
    var t = new Date(d.as_of_epoch * 1000), hm = ETHM.format(t);
    var mins = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(t).replace(":", "");
    if (mins >= 1600) return "Close · " + ETMD.format(t);
    var stale = now && (now - t.getTime()) > 6 * 3600 * 1000;
    return "As of " + hm + " ET" + (stale ? " · " + ETMD.format(t) : "");
  }
  function ingest(d) {
    if (!d || !d.symbols || !d.symbols.length) return;
    if (S.data && d.generated_epoch && S.data.generated_epoch && d.generated_epoch < S.data.generated_epoch) return;
    S.data = d;
    var fresh = !S.syms.length;
    d.symbols.forEach(function (q) {
      if (!isNum(q.price) || !isNum(q.prev_close)) return;
      var s = S.by[q.sym];
      if (!s) { s = { sym: q.sym, tape: [] }; S.syms.push(s); S.by[q.sym] = s; if (S.built) addTile(s); }
      var old = s.px;
      s.name = q.name; s.px = q.price; s.prev = q.prev_close; s.chg = q.change; s.pct = q.change_pct;
      s.open = q.open; s.high = q.high; s.low = q.low; s.vol = q.volume; s.spark = q.spark || []; s.bars = q.bars || [];
      s.dir = (!fresh && isNum(old) && old !== s.px) ? (s.px > old ? 1 : -1) : 0;
      s.dirty = true;
    });
    if (S.built) { renderAll(true); }
  }
  function load() {
    if (!window.fetch || location.protocol === "file:") return;
    fetch("data/floor.json?t=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) ingest(d); }).catch(function () { /* keep the last values */ });
  }

  // ---------------------------------------------------------------- colors
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(n, f) { var x = cs.getPropertyValue(n).trim(); return x || f; }
    S.colors = { pos: v("--pos", "#30d158"), neg: v("--neg", "#ff453a"), muted: v("--muted", "#8e8e93") };
  }
  function rgba(hex, a) {
    var h = hex.replace("#", ""); if (h.length === 3) h = h.replace(/./g, "$&$&");
    var n = parseInt(h, 16); if (isNaN(n)) return hex;
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }

  // ---------------------------------------------------------------- DOM
  function addTile(s) {
    var t = el("button", "fl-tile"); t.type = "button"; t.setAttribute("data-sym", s.sym); t.title = s.name || s.sym;
    var top = el("div", "fl-tt"); top.appendChild(el("span", "fl-tsym", s.sym)); s.ePct = el("span", "fl-tpct"); top.appendChild(s.ePct);
    var mid = el("div", "fl-tx"); mid.appendChild(el("span", "fl-tex", s.name || "")); s.eChg = el("span", "fl-tchg"); mid.appendChild(s.eChg);
    var pw = el("div", "fl-tpw"); s.ePx = el("span", "fl-tpx"); pw.appendChild(s.ePx);
    s.cv = el("canvas", "fl-tsp"); s.burst = el("span", "fl-burst");
    t.appendChild(top); t.appendChild(mid); t.appendChild(pw); t.appendChild(s.cv); t.appendChild(s.burst);
    s.tile = t; $("fl-grid").appendChild(t);
  }
  function buildTape(id, list) {
    var tr = $(id); tr.textContent = "";
    for (var c = 0; c < 2; c++) list.forEach(function (s) {
      var i = el("span", "fl-ti"); i.appendChild(el("b", null, s.sym));
      var p = el("span", "fl-tip"), ch = el("span", "fl-tic"); i.appendChild(p); i.appendChild(ch);
      tr.appendChild(i); s.tape.push([p, ch]);
    });
  }
  function build() {
    if (S.built || !S.syms.length) return;
    S.built = true;
    S.syms.forEach(addTile);
    var half = Math.ceil(S.syms.length / 2);
    buildTape("fl-tape-a", S.syms.slice(0, half)); buildTape("fl-tape-b", S.syms.slice(half));
    PULSE.forEach(function (k) {
      var s = S.by[k]; if (!s) return;
      var c = el("div", "fl-pc"); var h = el("div", "fl-pch"); h.appendChild(el("b", null, k)); s.pPct = el("span", "fl-pcq"); h.appendChild(s.pPct);
      var r = el("div", "fl-pcr"); s.pPx = el("span", "fl-pcp"); s.pChg = el("span", "fl-pcc"); r.appendChild(s.pPx); r.appendChild(s.pChg);
      s.pcv = el("canvas", "fl-pcv"); c.appendChild(h); c.appendChild(r); c.appendChild(s.pcv); $("fl-pulse").appendChild(c); s.pCard = c;
    });
    var bk = $("fl-book"); S.book = [];
    for (var i = 0; i < 4; i++) {
      var row = el("div", "fl-br fl-qr");
      var cells = [el("span", "fl-qk"), el("span", "fl-qv"), el("span", "fl-qk"), el("span", "fl-qv")];
      cells.forEach(function (c) { row.appendChild(c); }); bk.appendChild(row); S.book.push(cells);
    }
    $("fl-grid").addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest(".fl-tile"); if (!t) return;
      S.sel = t.getAttribute("data-sym"); markSel(); renderSide(true);
    });
    markHeld(); markSel(); sizeCanvases();
    if (window.ResizeObserver) new ResizeObserver(function () { sizeCanvases(); renderCharts(); }).observe($("fl-root"));
  }
  function markSel() { S.syms.forEach(function (s) { if (s.tile) s.tile.classList.toggle("fl-sel", s.sym === S.sel); }); }
  function markHeld() { S.syms.forEach(function (s) { if (s.tile) s.tile.classList.toggle("fl-mine", !!S.held[s.sym]); }); }
  function fitCanvas(c) {
    if (!c) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    var W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    c._dpr = dpr;
  }
  function sizeCanvases() {
    if (!S.built) return;
    S.syms.forEach(function (s) { fitCanvas(s.cv); fitCanvas(s.pcv); });
    fitCanvas($("fl-dchart"));
    ["fl-tape-a", "fl-tape-b"].forEach(function (id) {
      var tr = $(id); var w = tr.scrollWidth / 2; if (w > 0) tr.style.setProperty("--dur", Math.max(20, w / 55).toFixed(1) + "s");
    });
  }
  function line(c, pts, up, glow, base) {
    if (!c || !c.width || !pts || pts.length < 2) { if (c && c.width) c.getContext("2d").clearRect(0, 0, c.width, c.height); return; }
    var g = c.getContext("2d"), W = c.width, H = c.height, d = c._dpr || 1;
    g.clearRect(0, 0, W, H);
    var lo = Infinity, hi = -Infinity;
    pts.concat(isNum(base) ? [base] : []).forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    var span = hi - lo || 1, pad = 3 * d, col = up ? S.colors.pos : S.colors.neg;
    function Y(v) { return pad + (1 - (v - lo) / span) * (H - 2 * pad); }
    if (isNum(base)) { g.setLineDash([2 * d, 3 * d]); g.strokeStyle = rgba(S.colors.muted, 0.6); g.lineWidth = d; g.beginPath(); g.moveTo(0, Y(base)); g.lineTo(W, Y(base)); g.stroke(); g.setLineDash([]); }
    g.beginPath();
    for (var j = 0; j < pts.length; j++) { var x = j / (pts.length - 1) * W, y = Y(pts[j]); if (j) g.lineTo(x, y); else g.moveTo(x, y); }
    g.lineWidth = 1.6 * d; g.strokeStyle = col; g.lineJoin = "round";
    if (glow) { g.shadowColor = col; g.shadowBlur = 6 * d; }
    g.stroke(); g.shadowBlur = 0;
    g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, rgba(col, 0.28)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.fill();
  }

  // ---------------------------------------------------------------- render (only on real data)
  function paintTile(s, fx) {
    var up = s.chg >= 0;
    s.ePx.textContent = f2(s.px); s.ePct.textContent = sgn(s.pct) + "%"; s.eChg.textContent = sgn(s.chg);
    var t = s.tile; t.classList.toggle("up", up); t.classList.toggle("dn", !up);
    if (fx && s.dir) {
      s.flip = (s.flip || 0) ^ 1;
      t.classList.remove("fu0", "fu1", "fd0", "fd1"); s.ePx.classList.remove("ru0", "ru1", "rd0", "rd1");
      t.classList.add((s.dir > 0 ? "fu" : "fd") + s.flip); s.ePx.classList.add((s.dir > 0 ? "ru" : "rd") + s.flip);
    }
    for (var i = 0; i < s.tape.length; i++) { s.tape[i][0].textContent = f2(s.px); s.tape[i][1].textContent = sgn(s.pct) + "%"; s.tape[i][1].className = "fl-tic " + (up ? "up" : "dn"); }
    if (s.pCard) { s.pPx.textContent = f2(s.px); s.pPct.textContent = sgn(s.pct) + "%"; s.pChg.textContent = sgn(s.chg); s.pCard.classList.toggle("up", up); s.pCard.classList.toggle("dn", !up); }
  }
  function renderCharts() {
    if (!S.colors) return;
    S.syms.forEach(function (s) { line(s.cv, s.spark, s.chg >= 0, false); if (s.pcv) line(s.pcv, s.spark, s.chg >= 0, true, s.prev); });
    var sel = S.by[S.sel]; if (sel) line($("fl-dchart"), sel.spark, sel.chg >= 0, true, sel.prev);
  }
  function renderSide(fx) {
    var s = S.by[S.sel] || S.syms[0]; if (!s || !S.book) return;
    S.sel = s.sym;
    $("fl-book-sym").textContent = s.sym; $("fl-ts-sym").textContent = s.sym;
    var rows = [["Last", f2(s.px), "Prev close", f2(s.prev)], ["Change", sgn(s.chg), "% change", sgn(s.pct) + "%"],
                ["Open", f2(s.open), "Volume", big(s.vol)], ["Day low", f2(s.low), "Day high", f2(s.high)]];
    rows.forEach(function (r, i) { for (var k = 0; k < 4; k++) S.book[i][k].textContent = r[k]; });
    S.book[1][1].className = S.book[1][3].className = "fl-qv " + (s.chg >= 0 ? "up" : "dn");
    $("fl-bdep").textContent = f2(s.low); $("fl-adep").textContent = f2(s.high);
    var box = $("fl-ts"); box.textContent = "";
    var bars = (s.bars || []).slice().reverse();
    if (!bars.length) box.appendChild(el("div", "fl-tr fl-empty", "No intraday bars yet for this session."));
    bars.forEach(function (b, i) {
      var prevC = (bars[i + 1] || [0, null])[1], d = isNum(prevC) ? b[1] - prevC : 0;
      var vsPrev = (b[1] - s.prev) / s.prev * 100;
      var r = el("div", "fl-tr " + (d >= 0 ? "up" : "dn") + (fx && i === 0 ? " in" : ""));
      r.appendChild(el("span", null, ETHM.format(new Date((b[0] + 300) * 1000)))); r.appendChild(el("b", null, s.sym));
      r.appendChild(el("span", null, f2(b[1]))); r.appendChild(el("span", null, isNum(prevC) ? sgn(d) : "—")); r.appendChild(el("span", "fl-tex", sgn(vsPrev) + "%"));
      box.appendChild(r);
    });
    renderCharts();
  }
  function renderAll(fx) {
    if (!S.built) return;
    var movers = [];
    S.syms.forEach(function (s) { if (s.dirty) { s.dirty = false; paintTile(s, fx && !RM.matches); if (s.dir) movers.push(s); s.dir = 0; } });
    // burst label on the biggest real % mover of the day
    var top = S.syms.slice().sort(function (a, b) { return Math.abs(b.pct || 0) - Math.abs(a.pct || 0); })[0];
    S.syms.forEach(function (s) { if (s.tile) s.tile.classList.remove("big0", "big1"); });
    if (top && top.tile) { top.burst.textContent = (top.pct >= 0 ? "▲ " : "▼ ") + Math.abs(top.pct).toFixed(2) + "%"; if (!RM.matches) top.tile.classList.add("big" + (S.bflip = (S.bflip || 0) ^ 1)); }
    var vol = 0, adv = 0, n = 0;
    S.syms.forEach(function (s) { if (s.sym !== "VIX") { vol += s.vol || 0; n++; if (s.chg >= 0) adv++; } });
    $("fl-vol").textContent = big(vol); $("fl-adv").textContent = adv; $("fl-dec").textContent = n - adv;
    $("fl-breadth-bar").style.transform = "scaleX(" + (n ? adv / n : 0).toFixed(3) + ")";
    var a = asOfText(S.data, Date.now()); $("fl-asof").textContent = a.replace(/^As of /, "");
    $("fl-sim").firstChild.textContent = "Real quotes from Yahoo Finance, delayed ~15 min · " + a + (location.protocol === "file:" ? " (snapshot)" : "") + " · ";
    renderSide(fx);
  }
  function header() {
    var d = new Date(), sec = Math.floor(d.getTime() / 1000);
    if (sec === S.lastSec) return; S.lastSec = sec;
    $("fl-clock").textContent = ET.format(d).replace(/^24/, "00");
    $("fl-date").textContent = ETD.format(d).replace(/,/g, "");
    $("fl-tz").textContent = /EDT/.test(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).format(d)) ? "EDT" : "EST";
  }
  function seedAccount(d) {
    if (!d) return;
    S.held = {}; (d.positions || []).forEach(function (p) { if (p && p.symbol) S.held[p.symbol] = 1; });
    markHeld();
    var m = $("fl-mkt"), pill = $("fl-pill"), open = d.market_state === "REGULAR";
    if (m) m.textContent = open ? "Market open" : (d.market_label || "Market closed");
    if (pill) pill.classList.toggle("open", open);
  }

  // ---------------------------------------------------------------- loop
  function frame() { S.raf = requestAnimationFrame(frame); header(); }
  function start() {
    if (S.running) return;
    build(); if (!S.built) return;
    readColors(); sizeCanvases();
    S.running = true; $("fl-root").classList.remove("fl-paused");
    S.syms.forEach(function (s) { s.dirty = true; }); renderAll(false);
    S.raf = requestAnimationFrame(frame);
    load(); S.timer = setInterval(load, REFRESH_MS);
  }
  function stop() {
    if (!S.running) return;
    S.running = false; cancelAnimationFrame(S.raf); clearInterval(S.timer);
    var r = $("fl-root"); if (r) r.classList.add("fl-paused");
  }
  function sync() {
    if (!$("fl-root")) return;
    if (window.PQ_VIEW === "floor" && !document.hidden) start(); else stop();
  }

  window.PQFloor = { asOfText: asOfText };
  if (window.PQ_FLOOR) ingest(window.PQ_FLOOR);
  if (window.PQ_DATA) seedAccount(window.PQ_DATA);
  document.addEventListener("pq:data", function (e) { seedAccount(e.detail); });
  document.addEventListener("pq:view", sync);
  document.addEventListener("visibilitychange", sync);
  if (window.MutationObserver) new MutationObserver(function () { if (S.built) { readColors(); renderCharts(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  if (!S.syms.length && window.fetch && location.protocol !== "file:") {
    fetch("data/floor.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) { ingest(d); sync(); } }).catch(function () {});
  }
  sync();
})();
