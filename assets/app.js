/* Portfolio Quest dashboard. Plain JS, no libraries, no external requests except its own data file.
 *
 * Modes
 *  - Site (GitHub Pages): fetches data/portfolio.json (cache-busted) on load and every 60 s.
 *  - Standalone (dist/dashboard.html): renders the JSON embedded in <script id="embedded-data">,
 *    then, if window.DASHBOARD_CONFIG.remoteUrl is set, quietly tries to fetch fresher data from it
 *    every 60 s and silently keeps the embedded snapshot if that fails.
 */
(function () {
  "use strict";

  var CFG = window.DASHBOARD_CONFIG || {};
  var REFRESH_MS = 60000;
  var TZ = "America/New_York";
  var embeddedEl = document.getElementById("embedded-data");
  var EMBEDDED = null;
  if (embeddedEl) { try { EMBEDDED = JSON.parse(embeddedEl.textContent); } catch (e) { EMBEDDED = null; } }
  var STANDALONE = !!EMBEDDED;
  var DATA_URL = STANDALONE ? (CFG.remoteUrl || "") : (CFG.dataUrl || "data/portfolio.json");

  var state = { data: null, shownTotal: null, shownDmg: null, lastCheck: null, nextAt: null, source: null, timer: null };

  // ------------------------------------------------------------------ utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function money(x) { return x == null || isNaN(x) ? "n/a" : USD.format(x); }
  function money0(x) { return x == null || isNaN(x) ? "n/a" : USD0.format(x); }
  function sMoney(x) { return x == null || isNaN(x) ? "n/a" : (x > 0 ? "+" : x < 0 ? "−" : "") + USD.format(Math.abs(x)); }
  function sPct(x, d) { if (x == null || isNaN(x)) return "n/a"; d = d == null ? 2 : d; return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%"; }
  function pct(x, d) { return x == null || isNaN(x) ? "n/a" : x.toFixed(d == null ? 1 : d) + "%"; }
  function cls(x) { return x > 0 ? "pos" : x < 0 ? "neg" : "flat"; }
  function fmtET(iso, fallback, opts) {
    try {
      var d = new Date(iso);
      if (isNaN(d)) throw 0;
      return new Intl.DateTimeFormat("en-US", opts || { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
    } catch (e) { return fallback || "n/a"; }
  }
  function fmtDate(ymd, withYear) {
    var p = String(ymd).split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    var o = { timeZone: "UTC", month: "short", day: "numeric" };
    if (withYear) o.year = "numeric";
    return isNaN(d) ? ymd : d.toLocaleDateString("en-US", o);
  }
  function fmtWeekday(ymd) {
    var p = String(ymd).split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    return isNaN(d) ? ymd : d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  }
  function todayET() {
    try {
      var parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      return parts.slice(0, 10);
    } catch (e) { return ""; }
  }
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function countUp(el, from, to, fmt, ms) {
    if (from == null || reduceMotion || from === to) { el.textContent = fmt(to); return; }
    var t0 = null; ms = ms || 1100;
    function step(t) {
      if (!t0) t0 = t;
      var k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 4000);
  }
  function svgEl(tag, attrs, text) {
    var s = '<' + tag;
    for (var k in attrs) if (attrs[k] != null) s += " " + k + '="' + esc(attrs[k]) + '"';
    return s + (text != null ? ">" + text + "</" + tag + ">" : "/>");
  }

  // ------------------------------------------------------------------ header / banner
  function renderHeader(d) {
    var pill = $("market-pill"), st = d.market_state || "";
    pill.className = "pill " + (st === "REGULAR" ? "open" : (st === "PRE" || st === "POST") ? "ext" : "closed");
    $("market-label").textContent = d.market_label || st;
    $("updated").textContent = fmtET(d.generated_at_iso, d.generated_at_et);
    $("delay-note").textContent = (d.delay_note || "Prices may be delayed ~15 minutes.") +
      (d.quotes_as_of_et ? " Quotes as of " + d.quotes_as_of_et + "." : "");
    var cav = (d.caveats || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("");
    $("caveats").innerHTML = cav;
    if (STANDALONE) {
      var b = $("snapshot-banner");
      if (!b) {
        b = document.createElement("div"); b.id = "snapshot-banner"; b.className = "snapshot-banner";
        document.querySelector(".topbar").insertAdjacentElement("afterend", b);
      }
      var live = state.source === "remote";
      b.className = "snapshot-banner" + (live ? " live" : "");
      b.innerHTML = "<div>" + (live
        ? "● LIVE DATA loaded · updated <strong>" + esc(fmtET(d.generated_at_iso, d.generated_at_et)) + "</strong>"
        : "📸 SNAPSHOT as of <strong>" + esc(fmtET(d.generated_at_iso, d.generated_at_et)) + "</strong>") +
        (d.quotes_as_of_et ? " · quotes as of " + esc(d.quotes_as_of_et) : "") + "</div>";
    }
  }

  // ------------------------------------------------------------------ hero
  function renderHero(d, prev) {
    var a = d.account, L = d.level;
    $("level").textContent = L.level;
    countUp($("total"), state.shownTotal, a.total, money);
    state.shownTotal = a.total;
    var frac = Math.max(0, Math.min(1, L.xp / L.step));
    $("xp-fill").style.width = (frac * 100).toFixed(2) + "%";
    $("xp-bar-wrap").setAttribute("aria-valuenow", Math.round(frac * 100));
    $("xp-text").textContent = Math.floor(L.xp).toLocaleString("en-US") + " / " + L.step.toLocaleString("en-US");
    $("xp-next").textContent = money(L.xp_to_next) + " to LV " + (L.level + 1);
    $("xp-sub").textContent = "Level up every " + money0(L.step) + " of total value · LV " + (L.level + 1) + " at " + money0(L.next_level_at);

    var dmg = $("dmg"), dc = a.day_change;
    dmg.className = "dmg " + cls(dc);
    if (state.shownDmg !== dc) { void dmg.offsetWidth; dmg.classList.add("pop"); }
    countUp(dmg, state.shownDmg == null ? 0 : state.shownDmg, dc, sMoney, 1300);
    state.shownDmg = dc;
    var word = dc > 0 ? "HEAL" : dc < 0 ? "DAMAGE" : "NO CHANGE";
    $("dmg-sub").innerHTML = '<b class="' + cls(dc) + '">' + word + "</b> " + esc(sPct(a.day_change_pct)) + " today";
    var isToday = d.trade_date === todayET();
    $("dmg-label").textContent = (isToday ? "Today" : "Last session") + " · " + fmtWeekday(d.trade_date);

    var s = d.stats || {};
    var streak = s.streak_up > 0 ? "🔥 " + s.streak_up + " green day" + (s.streak_up > 1 ? "s" : "")
      : s.streak_down > 0 ? "❄️ " + s.streak_down + " red day" + (s.streak_down > 1 ? "s" : "") : "—";
    $("streak").textContent = streak;
    $("streak").title = "Consecutive up days from tracked history (best: " + (s.best_streak_up || 0) + ")";
    $("prev-total").textContent = money(a.prev_total);
    $("cash").textContent = money(a.cash);

    if (prev && prev.account && prev.account.total !== a.total) {
      var diff = a.total - prev.account.total;
      var f = document.createElement("div");
      f.className = "floater " + cls(diff); f.textContent = sMoney(diff);
      document.querySelector(".hero").appendChild(f);
      setTimeout(function () { f.remove(); }, 2300);
      toast("New data: " + sMoney(diff) + " since last check");
    }
  }

  // ------------------------------------------------------------------ cards
  var GLOWS = ["#4fa3ff", "#ff4fd8", "#38f2c8", "#ffd166", "#ff9f43"];
  function renderCards(d) {
    var html = (d.positions || []).map(function (p, i) {
      var covered = (d.options || []).filter(function (o) { return o.underlying === p.symbol && o.covered && o.type === "call" && o.position === "short"; });
      var sub = p.shares + " sh · " + esc(p.exchange || "") + (covered.length ? " · " + covered[0].shares_at_risk + " covered by call" : "");
      return '<article class="card">' +
        '<div class="glow" style="background:' + GLOWS[i % GLOWS.length] + '"></div>' +
        '<div class="card-head"><div class="avatar" aria-hidden="true">' + esc(p.icon) + '</div>' +
        '<div class="card-name"><div class="sym">' + esc(p.symbol) + '</div><div class="cls">' + esc(p.class) + "</div></div></div>" +
        '<div class="sub" title="' + esc(p.long_name) + '">' + esc(p.name) + " · " + sub + "</div>" +
        '<div class="stats">' +
        '<div><span class="stat-k">Value</span><span class="stat-v">' + money(p.value) + "</span></div>" +
        '<div><span class="stat-k">Price</span><span class="stat-v">' + money(p.price) + "</span></div>" +
        '<div><span class="stat-k">Day %</span><span class="stat-v ' + cls(p.day_change_pct) + '">' + sPct(p.day_change_pct) + "</span></div>" +
        '<div><span class="stat-k">Day $</span><span class="stat-v ' + cls(p.day_change) + '">' + sMoney(p.day_change) + "</span></div>" +
        "</div>" +
        '<div class="share"><div class="share-head"><span>Share of portfolio</span><span>' + pct(p.share_pct) + "</span></div>" +
        '<div class="bar"><div class="bar-fill" style="width:' + Math.max(0, Math.min(100, p.share_pct || 0)) + '%"></div></div></div>' +
        "</article>";
    }).join("");
    var a = d.account;
    html += '<article class="card cash"><div class="glow" style="background:#7b5cff"></div>' +
      '<div class="card-head"><div class="avatar" aria-hidden="true">🧪</div>' +
      '<div class="card-name"><div class="sym">CASH</div><div class="cls">Potion Reserve</div></div></div>' +
      '<div class="stats">' +
      '<div><span class="stat-k">Value</span><span class="stat-v">' + money(a.cash) + "</span></div>" +
      '<div><span class="stat-k">Day $</span><span class="stat-v flat">' + money(0) + "</span></div></div>" +
      '<div class="share"><div class="share-head"><span>Share of portfolio</span><span>' + pct(a.cash_share_pct) + "</span></div>" +
      '<div class="bar"><div class="bar-fill" style="width:' + Math.max(0, Math.min(100, a.cash_share_pct || 0)) + '%"></div></div></div></article>';
    $("cards").innerHTML = html;
  }

  // ------------------------------------------------------------------ boss
  function renderBoss(d) {
    var o = (d.options || [])[0], panel = $("boss-panel");
    if (!o) { panel.hidden = true; return; }
    panel.hidden = false;
    var R = Math.min(0.3, Math.max(0.06, Math.abs(o.distance_pct || 0) / 100 * 1.8));
    var lo = o.strike * (1 - R), hi = o.strike * (1 + R);
    var pos = Math.max(1, Math.min(99, (o.spot - lo) / (hi - lo) * 100));
    var itm = o.status === "ITM";
    var expDay = fmtWeekday(o.expiry);
    var shares = o.shares_at_risk, und = o.underlying, k = money(o.strike).replace(".00", "");
    var distTxt = money(Math.abs(o.distance)) + " (" + Math.abs(o.distance_pct).toFixed(2) + "%) " + (o.distance >= 0 ? "above" : "below") + " the " + k + " strike";
    var line1;
    if (o.expired) {
      line1 = "This option's expiry (" + esc(expDay) + ") has passed. Update data/holdings.json to show whether the shares were called away or the call expired worthless.";
    } else if (itm) {
      line1 = und + " is " + distTxt + ". If it is still above " + k + " at the close on " + expDay + ", your " + shares + " " + und +
        " shares will most likely be called away: sold at " + k + " each for " + money(o.assigned_proceeds) +
        ". You keep the premium you were paid, but give up any gain above " + k + ". Early assignment before then is also possible.";
    } else {
      line1 = und + " is " + distTxt + ". If " + und + " finishes above " + k + " on " + expDay + ", your " + shares + " " + und +
        " shares will likely be called away: sold at " + k + " each for " + money(o.assigned_proceeds) +
        ". You keep the premium you were paid but miss any gain above " + k + ". If it finishes at or below " + k +
        ", the call expires worthless and you keep the shares.";
    }
    var line2 = "The total above already subtracts this call's current value (" + money(Math.abs(o.liability)) +
      ") as a liability, so assignment would mostly swap shares for cash rather than create a new loss.";
    var odds = o.prob_finish_itm != null ? Math.round(o.prob_finish_itm * 100) + "%" : "n/a";
    var markLine = "mark $" + Number(o.mark).toFixed(2) + " · " + esc(o.mark_source) +
      (o.bid != null && o.ask != null ? " (bid " + o.bid.toFixed(2) + " / ask " + o.ask.toFixed(2) + ")" : "");

    $("boss").innerHTML =
      '<div class="boss-head"><div class="boss-skull" aria-hidden="true">👹</div><div>' +
      '<div class="boss-name">' + esc(o.boss_name) + "</div>" +
      '<div class="boss-sub">' + (o.position === "short" ? "Short " : "Long ") + o.contracts + "× " + esc(und) + " " + k + " " + esc(o.type) +
      " · expires " + esc(fmtDate(o.expiry, true)) + (o.covered ? " · covered" : "") + "</div></div>" +
      '<span class="tag ' + (itm ? "itm" : "otm") + '">' + (itm ? "ITM" : "OTM") + "</span></div>" +
      '<div class="countdown" id="countdown"><small>EXPIRES IN</small><span id="cd-val">--</span></div>' +
      '<div class="meter-wrap"><div class="meter" role="img" aria-label="' + esc(und + " $" + o.spot + " vs strike " + k) + '">' +
      '<div class="strike-line" style="left:50%"></div><div class="strike-lbl" style="left:50%">STRIKE ' + k + "</div>" +
      '<div class="marker' + (itm ? " itm" : "") + '" style="left:' + pos.toFixed(2) + '%" title="' + esc(und) + " " + money(o.spot) + '"></div></div>' +
      '<div class="meter-ends"><span class="z1">◀ keep shares · ' + money0(lo) + '</span><span class="z2">' + money0(hi) + " · called away ▶</span></div></div>" +
      '<div class="boss-stats">' +
      '<div><span class="stat-k">' + esc(und) + ' price</span><span class="stat-v">' + money(o.spot) + '</span><div class="fine" style="margin:2px 0 0">' +
      esc(sMoney(o.distance)) + " vs strike</div></div>" +
      '<div><span class="stat-k">Assignment risk</span><span class="stat-v ' + (itm ? "neg" : (o.assignment_risk === "LOW" || o.assignment_risk === "MODERATE") ? "pos" : "") + '" style="color:' +
      (!itm && o.assignment_risk !== "LOW" && o.assignment_risk !== "MODERATE" ? "var(--gold)" : "") + '">' + esc(o.assignment_risk || "n/a") + "</span>" +
      '<div class="fine" style="margin:2px 0 0">' + o.dte + " day" + (o.dte === 1 ? "" : "s") + " left</div></div>" +
      '<div><span class="stat-k">Call liability</span><span class="stat-v neg">' + sMoney(o.liability) + '</span><div class="fine" style="margin:2px 0 0">' +
      (o.day_change != null ? "today " + esc(sMoney(o.day_change)) : "") + "</div></div>" +
      '<div><span class="stat-k">Odds above ' + k + '</span><span class="stat-v">~' + odds + '</span><div class="fine" style="margin:2px 0 0">from option IV ' +
      (o.iv != null ? (o.iv * 100).toFixed(0) + "%" : "n/a") + "</div></div>" +
      "</div>" +
      '<p class="plain">' + esc(line1) + "</p>" +
      '<p class="plain">' + esc(line2) + "</p>" +
      '<div class="fine">' + markLine + (o.assignment_note ? " · " + esc(o.assignment_note) : "") + " Odds are a rough market-implied estimate, not a forecast.</div>";
    startCountdown(o.expiry_close_iso);
  }
  var cdTimer = null;
  function startCountdown(iso) {
    clearInterval(cdTimer);
    var target = new Date(iso).getTime();
    function tick() {
      var el = $("cd-val"); if (!el) return;
      var ms = target - Date.now();
      if (isNaN(ms)) { el.textContent = "n/a"; return; }
      if (ms <= 0) { el.textContent = "EXPIRED"; clearInterval(cdTimer); return; }
      var s = Math.floor(ms / 1000), dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
      function p2(n) { return (n < 10 ? "0" : "") + n; }
      el.textContent = dd + "d " + p2(hh) + "h " + p2(mm) + "m " + p2(ss) + "s";
    }
    tick(); cdTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ chart
  function renderChart(d) {
    var H = (d.history || []).filter(function (h) { return h.total != null; });
    var cw = $("chart").clientWidth || 640;
    var W = Math.max(300, Math.min(900, Math.round(cw))), Ht = W < 520 ? 190 : 230, pl = 64, pr = 18, pt = 18, pb = 30;
    var pts = H.map(function (h) { return { date: h.date, v: h.total, dc: h.day_change }; });
    var ghost = null;
    if (pts.length === 1 && d.account.prev_total != null) ghost = d.account.prev_total;
    var vals = pts.map(function (p) { return p.v; }); if (ghost != null) vals.push(ghost);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var span = Math.max(mx - mn, mx * 0.01, 50);
    mn -= span * 0.25; mx += span * 0.25;
    function y(v) { return pt + (1 - (v - mn) / (mx - mn)) * (Ht - pt - pb); }
    var n = pts.length + (ghost != null ? 1 : 0);
    function x(i) { return n <= 1 ? (pl + W - pr) / 2 : pl + i / (n - 1) * (W - pl - pr); }
    var s = '<svg viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="Account value history">' +
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#38f2c8" stop-opacity=".35"/><stop offset="1" stop-color="#38f2c8" stop-opacity="0"/></linearGradient></defs>';
    for (var g = 0; g <= 3; g++) {
      var gv = mn + (mx - mn) * g / 3, gy = y(gv);
      s += svgEl("line", { "class": "gridline", x1: pl, x2: W - pr, y1: gy, y2: gy });
      s += svgEl("text", { "class": "axis", x: pl - 8, y: gy + 4, "text-anchor": "end" }, esc(money0(gv)));
    }
    var step = d.level.step, first = Math.ceil(mn / step) * step;
    for (var lv = first; lv <= mx; lv += step) {
      s += svgEl("line", { "class": "lvl", x1: pl, x2: W - pr, y1: y(lv), y2: y(lv) });
      s += svgEl("text", { "class": "lvl-t", x: W - pr - 2, y: y(lv) - 4, "text-anchor": "end" }, "LV " + Math.round(lv / step));
    }
    var coords = [];
    var off = ghost != null ? 1 : 0;
    pts.forEach(function (p, i) { coords.push([x(i + off), y(p.v)]); });
    if (ghost != null) {
      s += svgEl("line", { "class": "ghost", x1: x(0), y1: y(ghost), x2: coords[0][0], y2: coords[0][1] });
      s += svgEl("circle", { cx: x(0), cy: y(ghost), r: 4, fill: "none", stroke: "#5b6491", "stroke-width": 2 });
      s += svgEl("text", { "class": "axis", x: x(0) - 4, y: y(ghost) + 20, "text-anchor": "start" }, "prior close, same holdings: " + esc(money0(ghost)));
    }
    if (coords.length > 1) {
      var dl = coords.map(function (c, i) { return (i ? "L" : "M") + c[0].toFixed(1) + "," + c[1].toFixed(1); }).join("");
      s += '<path d="' + dl + "L" + coords[coords.length - 1][0].toFixed(1) + "," + (Ht - pb) + "L" + coords[0][0].toFixed(1) + "," + (Ht - pb) + 'Z" fill="url(#ag)"/>';
      s += '<path class="line" d="' + dl + '"/>';
    }
    coords.forEach(function (c, i) {
      var p = pts[i], last = i === coords.length - 1;
      s += '<circle class="pt' + (last ? " last" : "") + '" cx="' + c[0].toFixed(1) + '" cy="' + c[1].toFixed(1) + '" r="' + (last ? 5.5 : 3.5) + '"><title>' +
        esc(fmtDate(p.date, true) + ": " + money(p.v) + (p.dc != null ? " (" + sMoney(p.dc) + ")" : "")) + "</title></circle>";
    });
    if (coords.length) {
      var lc = coords[coords.length - 1];
      s += svgEl("text", { "class": "val-t", x: Math.min(lc[0], W - pr - 40), y: lc[1] - 12, "text-anchor": "middle" }, esc(money(pts[pts.length - 1].v)));
    }
    var labelIdx = pts.length <= 2 ? pts.map(function (_, i) { return i; }) : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
    labelIdx.forEach(function (i) {
      s += svgEl("text", { "class": "axis", x: x(i + off), y: Ht - 8, "text-anchor": pts.length > 2 && i === 0 ? "start" : pts.length > 2 && i === pts.length - 1 ? "end" : "middle" }, esc(fmtDate(pts[i].date)));
    });
    s += "</svg>";
    $("chart").innerHTML = s;
    var st = d.stats || {};
    $("chart-foot").innerHTML =
      "<span>Days tracked: <b>" + (st.days_tracked || 0) + "</b></span>" +
      "<span>All-time high: <b>" + money(st.all_time_high) + "</b></span>" +
      (st.best_day ? '<span>Best day: <b class="' + cls(st.best_day.change) + '">' + sMoney(st.best_day.change) + "</b> (" + fmtDate(st.best_day.date) + ")</span>" : "") +
      (pts.length < 2 ? "<span>One point per trading day - the chart grows as history builds.</span>" : "");
  }

  // ------------------------------------------------------------------ achievements
  function renderBadges(d) {
    var A = d.achievements || [];
    $("ach-count").textContent = A.length + " earned";
    $("badges").innerHTML = A.map(function (a, i) {
      return '<div class="badge" style="animation-delay:' + (i * 60) + 'ms" title="' + esc(a.desc + " Earned " + fmtDate(a.date, true)) + '">' +
        '<div class="bi" aria-hidden="true">' + esc(a.icon) + '</div><div><div class="bt">' + esc(a.title) + '</div><div class="bd">' + esc(a.desc) + "</div></div></div>";
    }).join("") || '<div class="bd">No achievements yet.</div>';
    var old = document.querySelector(".locked-note"); if (old) old.remove();
    if (d.achievements_locked) {
      var n = document.createElement("div"); n.className = "locked-note";
      n.textContent = "🔒 " + d.achievements_locked + " more to unlock (streaks, new peaks, bigger clubs…)";
      $("badges").insertAdjacentElement("afterend", n);
    }
  }

  // ------------------------------------------------------------------ quest
  function fighter(f, kind, extra) {
    return '<div class="fighter ' + kind + '"><div class="fn">' + (kind === "champ" ? "🏆 Champion" : "🛡️ Buy &amp; hold") + "</div>" +
      '<div class="fd">' + esc(f.label) + "</div>" +
      '<div class="eq">' + money(f.equity) + "</div>" +
      '<div class="stats">' +
      '<div><span class="stat-k">Return</span><span class="stat-v ' + cls(f["return"]) + '">' + sPct(f["return"] == null ? null : f["return"] * 100) + "</span></div>" +
      '<div><span class="stat-k">Drawdown</span><span class="stat-v">' + pct(f.drawdown_now == null ? null : Math.abs(f.drawdown_now) * 100, 2) + "</span></div>" +
      '<div style="grid-column:1/-1"><span class="stat-k">Position</span><span class="stat-v" style="white-space:normal">' + esc(f.position) + extra + "</span></div>" +
      "</div></div>";
  }
  function questChart(series) {
    var W = 600, Ht = 120, p = 8;
    var all = []; series.forEach(function (s) { all.push(s.champ, s.bh); });
    var mn = Math.min.apply(null, all), mx = Math.max.apply(null, all); if (mx - mn < 1) { mx += 500; mn -= 500; }
    function x(i) { return p + i / (series.length - 1) * (W - 2 * p); }
    function y(v) { return p + (1 - (v - mn) / (mx - mn)) * (Ht - 2 * p); }
    function path(k) { return series.map(function (s, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(s[k]).toFixed(1); }).join(""); }
    return '<svg viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="Paper equity race">' +
      '<path d="' + path("bh") + '" fill="none" stroke="#4fa3ff" stroke-width="2"/>' +
      '<path d="' + path("champ") + '" fill="none" stroke="#ff4fd8" stroke-width="2.5"/></svg>';
  }
  function renderQuest(d) {
    var q = d.paper, panel = $("quest-panel");
    if (!q) { panel.hidden = true; return; }
    panel.hidden = false;
    var R = q.readiness || {}, ready = R.status === "READY";
    var objectives = (R.criteria || []).map(function (c) {
      var prog = "";
      if (c.progress) {
        var f = Math.max(0, Math.min(1, c.progress.current / c.progress.target));
        prog = '<div class="bar"><div class="bar-fill" style="width:' + (f * 100).toFixed(1) + '%"></div></div>';
      }
      var cur = c.progress ? c.progress.current + " / " + c.progress.target + " " + c.progress.unit : c.current;
      return '<li class="' + (c.pass ? "done" : "") + '"><span class="chk">' + (c.pass ? "✓" : "") + "</span><div>" +
        '<div class="od">' + esc(c.description) + '</div><div class="oc">goal ' + esc(c.threshold) + " · now " + esc(cur) + "</div>" + prog + "</div></li>";
    }).join("");
    var wf = q.walk_forward || {};
    var wfLine = wf.oos_cagr != null ? "Backtest (walk-forward, " + (wf.oos_years ? wf.oos_years.toFixed(1) + " yrs " : "") + "out-of-sample): champion " +
      pct(wf.oos_cagr * 100) + "/yr, Sharpe " + (wf.oos_sharpe != null ? wf.oos_sharpe.toFixed(2) : "n/a") + ", worst drop " + pct(Math.abs(wf.oos_max_dd) * 100, 0) +
      " vs buy-and-hold " + pct(wf.oos_bh_cagr * 100) + "/yr, Sharpe " + (wf.oos_bh_sharpe != null ? wf.oos_bh_sharpe.toFixed(2) : "n/a") + ", worst drop " +
      pct(Math.abs(wf.oos_bh_max_dd) * 100, 0) + ". Windows won: " + (wf.windows_won || "n/a") + "." : "";
    var series = q.series || [];
    var chart = series.length >= 2
      ? '<div class="quest-chart">' + questChart(series) + '<div class="chart-foot"><span style="color:#ff4fd8">━ champion</span><span style="color:#4fa3ff">━ buy &amp; hold</span></div></div>'
      : '<p class="quest-note">Forward paper trading started ' + esc(fmtDate(q.start_date, true)) + " · " + (q.forward_days || 0) +
        " trading days so far. The equity race chart appears after the first full trading day.</p>";
    var c = q.champion || {};
    var extra = c.target_next && c.target_next !== c.position ? " → " + esc(c.target_next) + " at next open" : "";
    $("quest").innerHTML =
      '<div class="quest-status"><span class="tag ' + (ready ? "ready" : "notready") + '">REAL-MONEY GATE: ' + esc(R.status || "n/a") + "</span>" +
      '<span class="label">Objectives ' + (R.passed || 0) + " / " + (R.total || 0) + " complete · data through " + esc(fmtDate(q.data_through, true)) +
      (q.spy_close ? " · SPY " + money(q.spy_close) : "") + "</span></div>" +
      '<div class="quest-grid"><div>' +
      '<div class="vs">' + fighter(c, "champ", extra) + '<div class="vs-mid">VS</div>' + fighter(q.buy_hold || {}, "bh", "") + "</div>" +
      chart + (wfLine ? '<p class="quest-note">' + esc(wfLine) + "</p>" : "") +
      "</div><div><div class=\"label\" style=\"margin-bottom:8px\">Quest objectives (all needed before real money is even considered)</div>" +
      '<ul class="objectives">' + objectives + "</ul>" +
      '<p class="quest-note">' + esc((R.notes || [])[0] || "Simulation only.") + "</p></div></div>";
  }

  // ------------------------------------------------------------------ main render / refresh
  function render(d) {
    var prev = state.data;
    state.data = d;
    try {
      renderHeader(d); renderHero(d, prev); renderCards(d); renderBoss(d); renderChart(d); renderBadges(d); renderQuest(d);
      $("app").setAttribute("aria-busy", "false");
    } catch (e) {
      console.error(e);
      $("app").insertAdjacentHTML("afterbegin", '<div class="panel error-box">Could not render dashboard data: ' + esc(e.message) + "</div>");
    }
  }
  function isNewer(a, b) {
    if (!b) return true;
    var ta = Date.parse(a.generated_at_iso), tb = Date.parse(b.generated_at_iso);
    return !isNaN(ta) && (isNaN(tb) || ta > tb);
  }
  function fetchJSON(url, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 10000);
    var u = url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
    return fetch(u, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { if (!j || !j.account || j.account.total == null) throw new Error("bad data"); return j; })
      .finally(function () { clearTimeout(to); });
  }
  function refresh() {
    state.lastCheck = new Date();
    state.nextAt = Date.now() + REFRESH_MS;
    if (!DATA_URL) return;
    fetchJSON(DATA_URL).then(function (j) {
      state.fetchError = false;
      if (STANDALONE) {
        if (isNewer(j, state.data)) { state.source = "remote"; render(j); }
      } else if (!state.data || j.generated_at_iso !== state.data.generated_at_iso) {
        render(j);
      }
    }).catch(function (e) {
      state.fetchError = true;
      if (!state.data && !STANDALONE) {
        $("app").innerHTML = '<div class="panel error-box">Could not load data/portfolio.json (' + esc(e.message) +
          "). If you opened this file directly from disk, serve the folder (python -m http.server) or use dist/dashboard.html.</div>";
      }
    });
  }
  function tickStatus() {
    var el = $("refresh-state");
    if (!DATA_URL) { el.textContent = "offline snapshot (no refresh URL configured)"; return; }
    var left = state.nextAt ? Math.max(0, Math.round((state.nextAt - Date.now()) / 1000)) : 0;
    var last = state.lastCheck ? fmtET(state.lastCheck.toISOString(), "", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "--";
    el.textContent = (STANDALONE && state.source !== "remote" ? "showing embedded snapshot · " : "") +
      "last check " + last + (state.fetchError ? (STANDALONE ? " (no fresher data reachable)" : " (failed, keeping last data)") : "") + " · next in " + left + "s";
  }

  var rsT = null, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () { if (state.data && window.innerWidth !== lastW) { lastW = window.innerWidth; renderChart(state.data); } }, 200);
  });
  if (STANDALONE) { state.source = "embedded"; render(EMBEDDED); }
  refresh();
  state.timer = setInterval(refresh, REFRESH_MS);
  setInterval(tickStatus, 1000); tickStatus();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.nextAt && Date.now() > state.nextAt - REFRESH_MS + 15000) refresh();
  });
})();
