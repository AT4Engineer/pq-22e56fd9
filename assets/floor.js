/* Trading Floor tab (#floor). Just for fun: a simulated trading-floor screen.
 * Holdings and watchlist symbols start from the latest saved prices in data/portfolio.json (window.PQ_DATA,
 * set by app.js); every move after that is a random walk. Nothing here is a real quote and nothing touches
 * the account. One requestAnimationFrame loop drives everything; it only runs while the tab is on screen and
 * the page is visible. DOM writes are batched and throttled. prefers-reduced-motion: slow ticks, no flashes.
 */
(function () {
  "use strict";
  var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  function $(id) { return document.getElementById(id); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function gauss() { var u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function f2(x) { return x.toFixed(2); }
  function sgn(x, d) { return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d == null ? 2 : d); }
  function big(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n)); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // Base prices for the simulated names are rough placeholders; they are labelled as simulated on screen.
  var UNIVERSE = [
    ["SPY", "NYSE Arca", 685, 0.9], ["QQQ", "NASDAQ", 610, 1.1], ["VOO", "NYSE Arca", 630, 0.9], ["VTI", "NYSE Arca", 335, 0.9],
    ["UPRO", "NYSE Arca", 150, 2.8], ["SPCX", "NASDAQ", 145, 2.2], ["AAPL", "NASDAQ", 265, 1.3], ["NVDA", "NASDAQ", 215, 2.0],
    ["TSLA", "NASDAQ", 450, 2.6], ["MSFT", "NASDAQ", 525, 1.2], ["AMZN", "NASDAQ", 230, 1.5], ["META", "NASDAQ", 740, 1.7],
    ["GOOGL", "NASDAQ", 260, 1.5], ["AMD", "NASDAQ", 250, 2.4], ["NFLX", "NASDAQ", 1150, 1.8], ["AVGO", "NASDAQ", 350, 2.0],
    ["PLTR", "NASDAQ", 185, 3.0], ["COIN", "NASDAQ", 340, 3.2], ["JPM", "NYSE", 305, 1.1], ["V", "NYSE", 345, 0.9],
    ["DIA", "NYSE Arca", 470, 0.8], ["IWM", "NYSE Arca", 245, 1.3], ["NDAQ", "NASDAQ", 95, 1.0], ["XOM", "NYSE", 115, 1.1]
  ];
  var PULSE = ["SPY", "QQQ", "VOO", "VTI", "AAPL", "NVDA", "TSLA", "UPRO", "SPCX", "MSFT"];
  var EXCH = ["NYSE", "NASDAQ", "ARCA", "BATS", "IEX", "EDGX", "MEMX"];
  var SPARK_N = 48, PULSE_N = 90;

  var S = { syms: [], by: {}, built: false, running: false, raf: 0, seeded: {}, held: {},
            sel: "UPRO", vol: 0, prints: [], tpsWin: [], pending: [], colors: null };

  function makeSym(row) {
    var base = row[2], prev = base * (1 + rnd(-0.015, 0.015));
    var s = { sym: row[0], exch: row[1], prev: prev, px: base, anchor: base, sig: row[3] / 100, hist: [], pulse: [],
              dirty: true, sparkDirty: true, dir: 0, flip: 0, bigUntil: 0, tile: null, tape: [] };
    // Fill the lines so the screen looks busy immediately: a short walk that ends at the current price.
    var p = base, h = [];
    for (var i = 0; i < PULSE_N; i++) { h.push(p); p *= 1 + gauss() * s.sig * 0.08; }
    var k = base / h[h.length - 1];
    s.pulse = h.map(function (v) { return v * k; });
    s.hist = s.pulse.slice(-SPARK_N);
    return s;
  }
  function initSyms() {
    S.syms = UNIVERSE.map(makeSym);
    S.syms.forEach(function (s) { S.by[s.sym] = s; });
  }
  // Seed holdings and watchlist from the feed (regular close, or the extended price in After Hours mode).
  function seed(d) {
    if (!d || !d.quotes || !S.syms.length) return;
    var ah = document.documentElement.classList.contains("mode-ah");
    S.held = {}; (d.positions || []).forEach(function (p) { if (p && p.symbol) S.held[p.symbol] = 1; });
    var notes = [];
    Object.keys(d.quotes).forEach(function (k) {
      var q = d.quotes[k];
      if (!q || q.kind !== "stock" || !isNum(q.price)) return;
      var pos = (d.positions || []).filter(function (p) { return p.symbol === k; })[0];
      var px = (ah && pos && isNum(pos.ext_price)) ? pos.ext_price : q.price;
      var s = S.by[k];
      if (!s) {
        s = makeSym([k, String(q.exchange || "NASDAQ").replace(/GS$|GM$/, "").toUpperCase(), px, 1.5]);
        S.syms.push(s); S.by[k] = s; if (S.built) addTile(s);
      }
      var firstSeed = !S.seeded[k];
      s.anchor = px;
      if (isNum(q.prev_close)) s.prev = q.prev_close;
      if (firstSeed) { var r = px / s.px; s.px = px; s.pulse = s.pulse.map(function (v) { return v * r; }); s.hist = s.pulse.slice(-SPARK_N); }
      S.seeded[k] = 1; s.dirty = s.sparkDirty = true;
      if (S.held[k]) notes.push(k + " $" + f2(px));
      if (s.tile) s.tile.classList.toggle("fl-mine", !!S.held[k]);
    });
    var n = $("fl-seed");
    if (n) n.textContent = (notes.length ? "Your holdings start from the latest saved prices (" + notes.join(", ") + ", " + (d.quotes_as_of_et || "") + ")." : "")
      + " Every move on this tab is a random simulation, not a real quote. It never changes your account.";
    var m = $("fl-mkt"), pill = $("fl-pill");
    if (m) {
      var open = d.market_state === "REGULAR";
      m.textContent = open ? "Market open" : (d.market_label || "Market closed");
      if (pill) { pill.classList.toggle("open", open); }
    }
  }

  // ---------------------------------------------------------------- colors (follow the theme: green/red, or cyan/amber after hours)
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(n, f) { var x = cs.getPropertyValue(n).trim(); return x || f; }
    S.colors = { pos: v("--pos", "#30d158"), neg: v("--neg", "#ff453a"), muted: v("--muted", "#8e8e93"), grid: v("--grid", "#1f1f22") };
  }
  function rgba(hex, a) {
    var h = hex.replace("#", ""); if (h.length === 3) h = h.replace(/./g, "$&$&");
    var n = parseInt(h, 16); if (isNaN(n)) return hex;
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }

  // ---------------------------------------------------------------- DOM
  function addTile(s) {
    var t = el("button", "fl-tile"); t.type = "button"; t.setAttribute("data-sym", s.sym);
    var top = el("div", "fl-tt"); s.eSym = el("span", "fl-tsym", s.sym); s.ePct = el("span", "fl-tpct");
    top.appendChild(s.eSym); top.appendChild(s.ePct);
    var mid = el("div", "fl-tx"); mid.appendChild(el("span", "fl-tex", s.exch)); s.eChg = el("span", "fl-tchg"); mid.appendChild(s.eChg);
    var pw = el("div", "fl-tpw"); s.ePx = el("span", "fl-tpx"); pw.appendChild(s.ePx);
    s.cv = el("canvas", "fl-tsp"); s.burst = el("span", "fl-burst");
    t.appendChild(top); t.appendChild(mid); t.appendChild(pw); t.appendChild(s.cv); t.appendChild(s.burst);
    if (S.held[s.sym]) t.classList.add("fl-mine");
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
    if (S.built) return;
    S.built = true;
    S.syms.forEach(addTile);
    var half = Math.ceil(S.syms.length / 2);
    buildTape("fl-tape-a", S.syms.slice(0, half)); buildTape("fl-tape-b", S.syms.slice(half));
    var pl = $("fl-pulse");
    PULSE.forEach(function (k) {
      var s = S.by[k]; if (!s) return;
      var c = el("div", "fl-pc"); var h = el("div", "fl-pch"); h.appendChild(el("b", null, k)); s.pPct = el("span", "fl-pcq"); h.appendChild(s.pPct);
      var r = el("div", "fl-pcr"); s.pPx = el("span", "fl-pcp"); s.pChg = el("span", "fl-pcc"); r.appendChild(s.pPx); r.appendChild(s.pChg);
      s.pcv = el("canvas", "fl-pcv"); c.appendChild(h); c.appendChild(r); c.appendChild(s.pcv); pl.appendChild(c); s.pCard = c;
    });
    // order book rows
    var bk = $("fl-book"); S.book = [];
    for (var i = 0; i < 8; i++) {
      var row = el("div", "fl-br");
      var bb = el("i", "fl-bbar"), ab = el("i", "fl-abar");
      var cells = [el("span", "fl-bp"), el("span", "fl-bs"), el("span", "fl-as"), el("span", "fl-ap")];
      row.appendChild(bb); row.appendChild(ab); cells.forEach(function (c) { row.appendChild(c); });
      bk.appendChild(row); S.book.push({ bb: bb, ab: ab, c: cells, bsz: 0, asz: 0 });
    }
    $("fl-grid").addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest(".fl-tile"); if (!t) return;
      S.sel = t.getAttribute("data-sym"); $("fl-book-sym").textContent = S.sel; markSel(); bookTick(true);
    });
    markSel();
    sizeCanvases();
    if (window.ResizeObserver) new ResizeObserver(function () { sizeCanvases(); }).observe($("fl-root"));
    else window.addEventListener("resize", sizeCanvases);
  }
  function markSel() { S.syms.forEach(function (s) { if (s.tile) s.tile.classList.toggle("fl-sel", s.sym === S.sel); }); }
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
    S.syms.forEach(function (s) { fitCanvas(s.cv); fitCanvas(s.pcv); s.sparkDirty = true; });
    fitCanvas($("fl-dchart"));
    // tape speed: constant pixels per second whatever the width
    ["fl-tape-a", "fl-tape-b"].forEach(function (id) {
      var tr = $(id); var w = tr.scrollWidth / 2; if (w > 0) tr.style.setProperty("--dur", Math.max(20, w / 55).toFixed(1) + "s");
    });
  }
  function line(c, pts, up, glow) {
    if (!c || !c.width || !pts.length) return;
    var g = c.getContext("2d"), W = c.width, H = c.height, d = c._dpr || 1;
    g.clearRect(0, 0, W, H);
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < pts.length; i++) { if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i]; }
    var span = hi - lo || 1, pad = 3 * d, col = up ? S.colors.pos : S.colors.neg;
    g.beginPath();
    for (var j = 0; j < pts.length; j++) {
      var x = j / (pts.length - 1) * W, y = pad + (1 - (pts[j] - lo) / span) * (H - 2 * pad);
      if (j) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.lineWidth = 1.6 * d; g.strokeStyle = col; g.lineJoin = "round";
    if (glow) { g.shadowColor = col; g.shadowBlur = 6 * d; }
    g.stroke(); g.shadowBlur = 0;
    g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, rgba(col, 0.28)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.fill();
  }

  // ---------------------------------------------------------------- simulation
  function move(s, pct) {
    var old = s.px;
    // random walk with a gentle pull back toward the seed so prices stay believable
    var pull = (s.anchor - s.px) / s.anchor * 0.02;
    var np = s.px * (1 + (pct != null ? pct : gauss() * s.sig * 0.06) + pull);
    np = Math.max(0.5, Math.round(np * 100) / 100);
    if (np === old) np = Math.round((old + (Math.random() < 0.5 ? -0.01 : 0.01)) * 100) / 100;
    s.px = np; s.dir = np > old ? 1 : -1; s.dirty = true;
    var size = (Math.random() < 0.12 ? (1 + (Math.random() * 40 | 0)) * 100 : (1 + (Math.random() * 9 | 0)) * 100);
    S.pending.push({ s: s, px: np, size: size, dir: s.dir });
    S.vol += size;
  }
  function bigMove(now) {
    var s = pick(S.syms), pct = (Math.random() < 0.5 ? -1 : 1) * rnd(0.004, 0.011) * (s.sig / 0.015);
    move(s, pct);
    s.bigUntil = now + 1400; s.bigFlag = true; s.burstTxt = (pct > 0 ? "▲ " : "▼ ") + Math.abs(pct * 100).toFixed(1) + "%";
    S.pending.push({ s: s, px: s.px, size: (20 + (Math.random() * 80 | 0)) * 100, dir: s.dir, blk: 1 });
  }

  // ---------------------------------------------------------------- render pieces
  function paintTile(s, now, fx) {
    var chg = s.px - s.prev, pct = chg / s.prev * 100, up = chg >= 0;
    s.ePx.textContent = f2(s.px);
    s.ePct.textContent = sgn(pct) + "%"; s.eChg.textContent = sgn(chg);
    var t = s.tile; t.classList.toggle("up", up); t.classList.toggle("dn", !up);
    if (fx && s.dir) {
      s.flip ^= 1;
      t.classList.remove("fu0", "fu1", "fd0", "fd1"); s.ePx.classList.remove("ru0", "ru1", "rd0", "rd1");
      t.classList.add((s.dir > 0 ? "fu" : "fd") + s.flip); s.ePx.classList.add((s.dir > 0 ? "ru" : "rd") + s.flip);
    }
    if (s.bigFlag) {
      s.bigFlag = false; s.burst.textContent = s.burstTxt;
      t.classList.remove("big0", "big1"); s.bflip = (s.bflip || 0) ^ 1; if (fx) t.classList.add("big" + s.bflip);
    }
    s.dir = 0;
  }
  function paintTape(s) {
    var chg = s.px - s.prev, pct = chg / s.prev * 100, cl = "fl-tic " + (chg >= 0 ? "up" : "dn");
    for (var i = 0; i < s.tape.length; i++) { s.tape[i][0].textContent = f2(s.px); s.tape[i][1].textContent = sgn(pct) + "%"; s.tape[i][1].className = cl; }
  }
  function paintPulse(s) {
    if (!s.pCard) return;
    var chg = s.px - s.prev, pct = chg / s.prev * 100, up = chg >= 0;
    s.pPx.textContent = f2(s.px); s.pPct.textContent = sgn(pct) + "%"; s.pChg.textContent = sgn(chg);
    s.pCard.classList.toggle("up", up); s.pCard.classList.toggle("dn", !up);
    line(s.pcv, s.pulse, up, true);
  }
  var ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  var ETD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "2-digit", day: "2-digit", year: "numeric" });
  var ETMS = function () { var d = new Date(); return ET.format(d) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
  function flushPrints(fx) {
    if (!S.pending.length) return;
    var box = $("fl-ts"), max = window.innerWidth <= 700 ? 10 : 16;
    var batch = S.pending.splice(0, S.pending.length);
    var take = batch.slice(-3), now = performance.now();
    batch.forEach(function () { S.tpsWin.push(now); });
    take.forEach(function (p) {
      var r = el("div", "fl-tr " + (p.dir > 0 ? "up" : "dn") + (p.blk ? " blk" : "") + (fx ? " in" : ""));
      r.appendChild(el("span", null, ETMS())); r.appendChild(el("b", null, p.s.sym)); r.appendChild(el("span", null, f2(p.px)));
      r.appendChild(el("span", null, p.size.toLocaleString("en-US"))); r.appendChild(el("span", "fl-tex", pick(EXCH)));
      box.insertBefore(r, box.firstChild);
    });
    while (box.childNodes.length > max) box.removeChild(box.lastChild);
  }
  function bookTick(force) {
    var s = S.by[S.sel]; if (!s || !S.book) return;
    var spread = Math.max(0.01, Math.round(s.px * 0.0001 * 100) / 100), bid = s.px - spread / 2, ask = s.px + spread / 2;
    var bt = 0, at = 0, rows = [];
    for (var i = 0; i < S.book.length; i++) {
      var r = S.book[i];
      var nb = force || !r.bsz || Math.random() < 0.45 ? (2 + (Math.random() * 12 | 0) + i * 4) * 100 : r.bsz;
      var na = force || !r.asz || Math.random() < 0.45 ? (2 + (Math.random() * 12 | 0) + i * 4) * 100 : r.asz;
      rows.push([Math.floor((bid - i * 0.01) * 100) / 100, nb, na, Math.ceil((ask + i * 0.01) * 100) / 100]);
      bt += nb; at += na;
    }
    var mx = 0; rows.forEach(function (x) { mx = Math.max(mx, x[1], x[2]); });
    var cb = 0, ca = 0, cumB = [], cumA = [];
    rows.forEach(function (x, i) {
      var r = S.book[i];
      if (r.bsz && x[1] !== r.bsz) { r.c[1].classList.remove("hit0", "hit1"); r.c[1].classList.add("hit" + (r.h = (r.h || 0) ^ 1)); }
      if (r.asz && x[2] !== r.asz) { r.c[2].classList.remove("hit0", "hit1"); r.c[2].classList.add("hit" + (r.h2 = (r.h2 || 0) ^ 1)); }
      r.bsz = x[1]; r.asz = x[2];
      r.c[0].textContent = f2(x[0]); r.c[1].textContent = x[1].toLocaleString("en-US"); r.c[2].textContent = x[2].toLocaleString("en-US"); r.c[3].textContent = f2(x[3]);
      r.bb.style.transform = "scaleX(" + (x[1] / mx).toFixed(3) + ")"; r.ab.style.transform = "scaleX(" + (x[2] / mx).toFixed(3) + ")";
      cb += x[1]; ca += x[2]; cumB.push(cb); cumA.push(ca);
    });
    $("fl-bdep").textContent = big(bt); $("fl-adep").textContent = big(at);
    var c = $("fl-dchart"); if (!c || !c.width) return;
    var g = c.getContext("2d"), W = c.width, H = c.height, top = Math.max(cb, ca), n = cumB.length, half = W / 2;
    g.clearRect(0, 0, W, H);
    function side(cum, col, dirn) {
      g.beginPath(); g.moveTo(half, H);
      for (var k = 0; k < n; k++) { var x = half + dirn * (k + 1) / n * half, y = H - cum[k] / top * (H - 4); var px = half + dirn * k / n * half; g.lineTo(px, y); g.lineTo(x, y); }
      g.lineTo(half + dirn * half, H); g.closePath();
      g.fillStyle = rgba(col, 0.25); g.fill(); g.strokeStyle = col; g.lineWidth = 1.5 * (c._dpr || 1); g.stroke();
    }
    side(cumB, S.colors.pos, -1); side(cumA, S.colors.neg, 1);
  }
  function header(now) {
    var d = new Date(), sec = Math.floor(d.getTime() / 1000);
    if (sec !== S.lastSec) {
      S.lastSec = sec;
      $("fl-clock").textContent = ET.format(d).replace(/^24/, "00");
      $("fl-date").textContent = ETD.format(d).replace(/,/g, "");
      var dst = /EDT/.test(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).format(d));
      $("fl-tz").textContent = dst ? "EDT" : "EST";
    }
    while (S.tpsWin.length && now - S.tpsWin[0] > 1000) S.tpsWin.shift();
    $("fl-tps").textContent = S.tpsWin.length;
    $("fl-vol").textContent = big(S.vol);
    var adv = 0; S.syms.forEach(function (s) { if (s.px >= s.prev) adv++; });
    $("fl-adv").textContent = adv; $("fl-dec").textContent = S.syms.length - adv;
    $("fl-breadth-bar").style.transform = "scaleX(" + (adv / S.syms.length).toFixed(3) + ")";
  }

  // ---------------------------------------------------------------- loop
  var T = { last: 0, acc: 0, tile: 0, tape: 0, spark: 0, pulse: 0, book: 0, hdr: 0, prints: 0, sample: 0, psample: 0, nextBig: 0 };
  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    var reduced = RM.matches, fx = !reduced;
    var dt = Math.min(250, now - (T.last || now)); T.last = now;
    var TICK = reduced ? 900 : 45;
    T.acc += dt;
    var steps = 0;
    while (T.acc >= TICK && steps < 6) {
      T.acc -= TICK; steps++;
      var n = reduced ? 3 : 1 + (Math.random() * 3 | 0);
      for (var i = 0; i < n; i++) move(pick(S.syms));
    }
    if (T.acc > TICK) T.acc = 0;
    if (!T.nextBig) T.nextBig = now + rnd(1500, 3000);
    if (now > T.nextBig) { bigMove(now); T.nextBig = now + (reduced ? rnd(8000, 12000) : rnd(2200, 4800)); }
    if (now - T.sample > 400) { T.sample = now; S.syms.forEach(function (s) { s.hist.push(s.px); if (s.hist.length > SPARK_N) s.hist.shift(); s.sparkDirty = true; }); }
    if (now - T.psample > 900) { T.psample = now; S.syms.forEach(function (s) { s.pulse.push(s.px); if (s.pulse.length > PULSE_N) s.pulse.shift(); }); }
    if (now - T.tile > (reduced ? 900 : 70)) { T.tile = now; S.syms.forEach(function (s) { if (s.dirty) { s.dirty = false; paintTile(s, now, fx); s.tapeDirty = true; } }); }
    if (now - T.spark > 260) { T.spark = now; S.syms.forEach(function (s) { if (s.sparkDirty) { s.sparkDirty = false; line(s.cv, s.hist, s.px >= s.prev, false); } }); }
    if (now - T.tape > 600) { T.tape = now; S.syms.forEach(function (s) { if (s.tapeDirty) { s.tapeDirty = false; paintTape(s); } }); }
    if (now - T.prints > (reduced ? 1000 : 110)) { T.prints = now; flushPrints(fx); }
    if (now - T.book > (reduced ? 1500 : 320)) { T.book = now; bookTick(false); }
    if (now - T.pulse > 900) { T.pulse = now; PULSE.forEach(function (k) { if (S.by[k]) paintPulse(S.by[k]); }); }
    if (now - T.hdr > 100) { T.hdr = now; header(now); }
  }
  function start() {
    if (S.running) return;
    build(); readColors(); sizeCanvases();
    S.running = true; T.last = 0; $("fl-root").classList.remove("fl-paused");
    S.syms.forEach(function (s) { s.dirty = s.sparkDirty = s.tapeDirty = true; });
    T.pulse = T.book = T.tape = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!S.running) return;
    S.running = false; cancelAnimationFrame(S.raf);
    var r = $("fl-root"); if (r) r.classList.add("fl-paused");
  }
  function sync() {
    if (!$("fl-root")) return;
    if (window.PQ_VIEW === "floor" && !document.hidden) start(); else stop();
  }

  initSyms();
  if (window.PQ_DATA) seed(window.PQ_DATA);
  document.addEventListener("pq:data", function (e) { seed(e.detail); });
  document.addEventListener("pq:view", sync);
  document.addEventListener("visibilitychange", sync);
  // theme switch (Regular / After Hours): recolor the canvases, reseed from the extended price
  if (window.MutationObserver) new MutationObserver(function () {
    var ah = document.documentElement.classList.contains("mode-ah");
    if (ah !== S.ah) { S.ah = ah; S.seeded = {}; if (window.PQ_DATA) seed(window.PQ_DATA); }
    readColors(); S.syms.forEach(function (s) { s.sparkDirty = true; }); T.pulse = 0;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  S.ah = document.documentElement.classList.contains("mode-ah");
  sync();
})();
