/* Portfolio Tracker dashboard. Plain JS, no libraries, no external requests except its own data files.
 *
 * Views (hash routes): #stocks (iOS Stocks-style list, default on phones; #stocks/<SYMBOL> opens the detail
 * panel), #overview (summary, positions, covered call, history, paper trading; default on wide screens),
 * #transactions (data/transactions.json, newest first) and #edit (builds a prefilled GitHub issue that the
 * apply-trade workflow turns into a holdings update).
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

  var state = { data: null, lastCheck: null, nextAt: null, source: null, fetchError: false };

  // ------------------------------------------------------------------ utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  var USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function money(x) { return isNum(x) ? (x < 0 ? "−" : "") + USD.format(Math.abs(x)) : "n/a"; }
  function money0(x) { return isNum(x) ? USD0.format(x) : "n/a"; }
  function sMoney(x) { return isNum(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + USD.format(Math.abs(x)) : "n/a"; }
  function sPct(x, d) { if (!isNum(x)) return "n/a"; d = d == null ? 2 : d; return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) + "%"; }
  function pct(x, d) { return isNum(x) ? (x < 0 ? "−" : "") + Math.abs(x).toFixed(d == null ? 2 : d) + "%" : "n/a"; }
  function qty(x) { return isNum(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "n/a"; }
  function cls(x) { return isNum(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : ""; }
  function fmtET(iso, fallback, opts) {
    try {
      var d = new Date(iso);
      if (isNaN(d)) throw 0;
      return new Intl.DateTimeFormat("en-US", opts || { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
    } catch (e) { return fallback || "n/a"; }
  }
  function ymdDate(ymd) { var p = String(ymd).split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); }
  function fmtDate(ymd, opts) {
    var d = ymdDate(ymd);
    var o = opts || { month: "short", day: "numeric" }; o.timeZone = "UTC";
    return isNaN(d) ? String(ymd) : d.toLocaleDateString("en-US", o);
  }
  function svgEl(tag, attrs, text) {
    var s = "<" + tag;
    for (var k in attrs) if (attrs[k] != null) s += " " + k + '="' + esc(attrs[k]) + '"';
    return s + (text != null ? ">" + text + "</" + tag + ">" : "/>");
  }

  // ------------------------------------------------------------------ motion (CSS + requestAnimationFrame, no libraries)
  var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  function motion() { return !RM.matches; }
  function ease3(t) { return 1 - Math.pow(1 - t, 3); }
  function easeIO(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  // Animate a number from `from` to `to`, writing fmt(value) into el each frame.
  function countUp(el, from, to, fmt, dur) {
    if (!el) return;
    if (el._cu) cancelAnimationFrame(el._cu);
    if (!motion() || !isNum(from) || !isNum(to) || from === to) { el.textContent = fmt(to); return; }
    dur = dur || 700;
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), v = from + (to - from) * ease3(k);
      el.textContent = fmt(k >= 1 ? to : v);
      el._cu = k < 1 ? requestAnimationFrame(step) : null;
    }
    el.textContent = fmt(from);
    el._cu = requestAnimationFrame(step);
  }
  // Briefly tint a cell green or red after its value changed.
  function flash(el, up, textOnly) {
    if (!el || !motion()) return;
    var on = textOnly ? (up ? "flash-up-text" : "flash-down-text") : (up ? "flash-up" : "flash-down");
    el.classList.remove("flash-up", "flash-down", "flash-up-text", "flash-down-text");
    void el.offsetWidth;
    el.classList.add(on);
  }

  // ------------------------------------------------------------------ header / footer
  function renderHeader(d) {
    var st = d.market_state || "";
    $("market-pill").className = "market" + (st === "REGULAR" ? " open" : "");
    $("market-label").textContent = d.market_label || st || "Market status unknown";
    $("updated").textContent = fmtET(d.generated_at_iso, d.generated_at_et);
    $("delay-note").textContent = (d.delay_note || "Prices may be delayed ~15 minutes.") +
      (d.quotes_as_of_et ? " Quotes as of " + d.quotes_as_of_et + "." : "");
    $("caveats").innerHTML = (d.caveats || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("");
    if (STANDALONE) {
      var b = $("snapshot-banner");
      if (!b) {
        b = document.createElement("div"); b.id = "snapshot-banner"; b.className = "snapshot-banner";
        document.querySelector(".topbar").insertAdjacentElement("afterend", b);
      }
      var live = state.source === "remote";
      b.innerHTML = "<div>" + (live ? "Live data loaded, updated " : "Offline snapshot as of ") +
        "<strong>" + esc(fmtET(d.generated_at_iso, d.generated_at_et)) + "</strong>" +
        (d.quotes_as_of_et ? " &middot; quotes as of " + esc(d.quotes_as_of_et) : "") + "</div>";
    }
  }

  // ------------------------------------------------------------------ summary
  function renderSummary(d) {
    var a = d.account || {};
    $("total").textContent = money(a.total);
    if (isNum(ui.animFrom) && isNum(a.total) && Math.abs(ui.animFrom - a.total) > 0.004) {
      countUp($("total"), ui.animFrom, a.total, money); flash($("total"), a.total > ui.animFrom, true);
    }
    $("total-sub").textContent = "Stocks " + money(a.stocks_value) + " + cash " + money(a.cash) +
      (isNum(a.option_liability) && a.option_liability !== 0 ? " − short call " + money(Math.abs(a.option_liability)) : "");
    var dc = $("day-change");
    dc.innerHTML = "<span>" + sMoney(a.day_change) + '</span> <span class="pct">(' + sPct(a.day_change_pct) + ")</span>";
    dc.className = "stat-value " + cls(a.day_change);
    $("day-sub").textContent = "vs previous close " + money(a.prev_total) + (d.trade_date ? " · session " + fmtDate(d.trade_date, { weekday: "short", month: "short", day: "numeric" }) : "");
    $("cash").textContent = money(a.cash);
    $("cash-sub").textContent = isNum(a.cash_share_pct) ? pct(a.cash_share_pct) + " of portfolio" : "";
    var o = (d.options || [])[0];
    $("opt-liab").textContent = isNum(a.option_liability) ? money(a.option_liability) : "n/a";
    $("opt-sub").textContent = o ? o.label + (isNum(o.mark) ? " · mark " + money(o.mark) : "") : "No open options";
  }

  // ------------------------------------------------------------------ positions
  function cell(label, html, klass) {
    return '<td data-label="' + esc(label) + '"' + (klass ? ' class="' + klass + '"' : "") + ">" + (html === "" ? "" : '<span class="cv">' + html + "</span>") + "</td>";
  }
  function renderPositions(d) {
    var a = d.account || {}, total = a.total;
    var rows = (d.positions || []).map(function (p) {
      var title = p.long_name && p.long_name !== p.name ? ' title="' + esc(p.long_name) + '"' : "";
      return "<tr>" +
        cell("Symbol", '<span class="sym">' + esc(p.symbol) + '</span><span class="subtle mobile-name">' + esc(p.name) + "</span>", "cell-sym") +
        '<td class="col-name"' + title + ">" + esc(p.name) + (p.exchange ? ' <span class="subtle">' + esc(p.exchange) + "</span>" : "") + "</td>" +
        cell("Qty", qty(p.shares), "num") +
        cell("Price", money(p.price), "num") +
        cell("Market value", money(p.value), "num") +
        cell("Day $", '<span class="' + cls(p.day_change) + '">' + sMoney(p.day_change) + "</span>", "num") +
        cell("Day %", '<span class="' + cls(p.day_change_pct) + '">' + sPct(p.day_change_pct) + "</span>", "num") +
        cell("% of portfolio", pct(p.share_pct), "num") +
        "</tr>";
    });
    (d.options || []).forEach(function (o) {
      var prevVal = isNum(o.prev_mark) ? o.prev_mark * o.multiplier * o.contracts : null;
      var dpct = isNum(o.day_change) && prevVal ? o.day_change / prevVal * 100 : null;
      var share = isNum(o.liability) && total ? o.liability / total * 100 : null;
      var q = (o.position === "short" ? -1 : 1) * o.contracts;
      rows.push("<tr>" +
        cell("Symbol", '<span class="sym">' + esc(o.underlying) + " " + esc(o.type === "call" ? "C" : "P") + esc(o.strike) + '</span><span class="subtle mobile-name">' + esc((o.position === "short" ? "Short " : "") + o.label) + "</span>", "cell-sym") +
        '<td class="col-name">' + esc((o.position === "short" ? "Short " : "Long ") + o.label) + (o.covered ? ' <span class="subtle">covered</span>' : "") + "</td>" +
        cell("Qty", qty(q) + ' <span class="subtle">contract' + (Math.abs(q) === 1 ? "" : "s") + "</span>", "num") +
        cell("Price (mark)", money(o.mark), "num") +
        cell("Market value", money(o.liability), "num") +
        cell("Day $", '<span class="' + cls(o.day_change) + '">' + sMoney(o.day_change) + "</span>", "num") +
        cell("Day %", '<span class="' + cls(dpct) + '">' + sPct(dpct) + "</span>", "num") +
        cell("% of portfolio", pct(share), "num") +
        "</tr>");
    });
    rows.push("<tr>" +
      cell("Symbol", '<span class="sym">Cash</span><span class="subtle mobile-name">USD</span>', "cell-sym") +
      '<td class="col-name">Cash <span class="subtle">USD</span></td>' +
      cell("Qty", "", "num") + cell("Price", "", "num") +
      cell("Market value", money(a.cash), "num") +
      cell("Day $", "", "num") + cell("Day %", "", "num") +
      cell("% of portfolio", pct(a.cash_share_pct), "num") +
      "</tr>");
    $("positions-body").innerHTML = rows.join("");
    $("positions-foot").innerHTML = "<tr>" +
      cell("", "Total", "cell-sym") + '<td class="col-name"></td>' +
      cell("Qty", "", "num") + cell("Price", "", "num") +
      cell("Market value", money(a.total), "num") +
      cell("Day $", '<span class="' + cls(a.day_change) + '">' + sMoney(a.day_change) + "</span>", "num") +
      cell("Day %", '<span class="' + cls(a.day_change_pct) + '">' + sPct(a.day_change_pct) + "</span>", "num") +
      cell("% of portfolio", "100.00%", "num") + "</tr>";
    var src = (d.positions || [])[0];
    $("positions-note").textContent = "The short call is a liability: its market value is negative and is subtracted from the account." +
      (src && src.price_source ? " Stock prices: " + src.price_source + "." : "");
  }

  // ------------------------------------------------------------------ covered call
  function kv(k, v, vClass) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v' + (vClass ? " " + vClass : "") + '">' + v + "</span></div>";
  }
  function renderOption(d) {
    var o = (d.options || [])[0], panel = $("option-panel");
    if (!o) { panel.hidden = true; return; }
    panel.hidden = false;
    var n = o.contracts, shares = o.shares_at_risk || n * o.multiplier;
    var strike = money(o.strike), exp = fmtDate(o.expiry, { month: "short", day: "numeric", year: "numeric" });
    var proceeds = isNum(o.assigned_proceeds) ? o.assigned_proceeds : o.strike * shares;
    var vsStrike = isNum(o.distance)
      ? (o.distance > 0 ? money(o.distance) + " above" : o.distance < 0 ? money(Math.abs(o.distance)) + " below" : "exactly at")
      : "n/a";
    $("opt-label").textContent = (o.position === "short" ? "Short " : "Long ") + o.label;

    var plain = [];
    if (o.expired) {
      plain.push("<p><strong>This option has expired.</strong> Update data/holdings.json to reflect whether the shares were sold (assigned) or the option expired worthless.</p>");
    } else if (o.type === "call" && o.position === "short") {
      plain.push("<p><strong>If " + esc(o.underlying) + " closes above " + strike + " on " + esc(exp) + ", " + shares +
        " shares are likely sold at " + strike + " = " + money(proceeds) + ".</strong></p>");
      plain.push("<p>If it closes at or below " + strike + ", the option expires worthless and you keep the shares. " +
        "Either way, the premium already received is yours to keep.</p>");
      plain.push("<p>Now: " + esc(o.underlying) + " is " + money(o.spot) + ", " + vsStrike + " the strike" +
        (isNum(o.distance_pct) ? " (" + sPct(o.distance_pct) + ")" : "") + "; the option is " +
        (o.itm ? "in the money" : "out of the money") + " with " + o.dte + " day" + (o.dte === 1 ? "" : "s") + " to expiry." +
        (o.assignment_note ? " " + esc(o.assignment_note) : "") + "</p>");
    }
    $("opt-plain").innerHTML = plain.join("");

    var hasQuote = isNum(o.bid) && isNum(o.ask) && (o.bid > 0 || o.ask > 0);
    var timeVal = isNum(o.extrinsic) ? o.extrinsic : null;
    var g = [
      kv("Contract", esc(o.contract || o.label)),
      kv("Position", esc((o.position === "short" ? "Short " : "Long ") + n + " contract" + (n === 1 ? "" : "s") + " (" + shares + " shares)") + (o.covered ? ", covered" : "")),
      kv("Mark (per share)", money(o.mark)),
      kv("Mark source", o.quote_reused ? "last good bid/ask mid (no live quote now)" : esc(o.mark_source || "n/a")),
      kv("Bid / ask", hasQuote ? money(o.bid) + " / " + money(o.ask) + (o.quote_reused ? ' <span class="subtle">last good quote' + (o.quote_as_of_et ? ", " + esc(o.quote_as_of_et) : "") + "</span>" : "") : "no live quote"),
      kv("Last trade", isNum(o.last) ? money(o.last) + (o.last_trade_et ? ' <span class="subtle">' + esc(o.last_trade_et) + "</span>" : "") : "n/a"),
      kv("Liability (mark × " + shares + ")", money(o.liability)),
      kv("Day change", sMoney(o.day_change), cls(o.day_change)),
      kv(o.underlying + " price", money(o.spot)),
      kv("Strike", strike),
      kv("Distance to strike", (isNum(o.distance) ? sMoney(o.distance) : "n/a") + (isNum(o.distance_pct) ? " (" + sPct(o.distance_pct) + ")" : "")),
      kv("Moneyness", o.itm ? "In the money" : "Out of the money"),
      kv("Expiry", esc(exp) + ' <span class="subtle">4:00 PM ET</span>'),
      kv("Days to expiry", o.expired ? "expired" : String(o.dte)),
      kv("Intrinsic value", money(o.intrinsic) + ' <span class="subtle">/ share</span>'),
      kv("Time value", money(timeVal) + ' <span class="subtle">/ share</span>'),
      kv("Implied volatility", isNum(o.iv) ? pct(o.iv * 100, 1) : "n/a"),
      kv("Market-implied chance above strike", isNum(o.prob_finish_itm) ? pct(o.prob_finish_itm * 100, 0) + ' <span class="subtle">rough</span>' : "n/a"),
      kv("Assignment risk", esc(o.assignment_risk ? o.assignment_risk.charAt(0) + o.assignment_risk.slice(1).toLowerCase() : "n/a")),
      kv("Proceeds if assigned", money(proceeds)),
      kv("Open interest / volume", (isNum(o.open_interest) ? qty(o.open_interest) : "n/a") + " / " + (isNum(o.volume) ? qty(o.volume) : "n/a"))
    ];
    $("opt-grid").innerHTML = g.join("");
  }

  // ------------------------------------------------------------------ chart
  function niceStep(range, ticks) {
    var raw = range / Math.max(1, ticks), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function renderChart(d, anim) {
    var H = (d.history || []).filter(function (h) { return isNum(h.total); });
    var el = $("chart");
    if (!H.length) { el.innerHTML = '<p class="note">No history yet.</p>'; $("chart-foot").textContent = ""; return; }
    var W = Math.max(300, Math.round(el.clientWidth || 640)), Ht = W < 500 ? 200 : 260;
    var pl = W < 500 ? 58 : 72, pr = 16, pt = 12, pb = 28;
    var vals = H.map(function (h) { return h.total; });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var pad = Math.max((mx - mn) * 0.1, mx * 0.01, 1);
    mn -= pad; mx += pad;
    var step = niceStep(mx - mn, 4);
    var lo = Math.floor(mn / step) * step, hi = Math.ceil(mx / step) * step;
    function y(v) { return pt + (1 - (v - lo) / (hi - lo)) * (Ht - pt - pb); }
    function x(i) { return H.length <= 1 ? (pl + W - pr) / 2 : pl + i / (H.length - 1) * (W - pl - pr); }
    var s = '<svg viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="Account value history">';
    for (var g = lo; g <= hi + step / 2; g += step) {
      s += svgEl("line", { "class": "gridline", x1: pl, x2: W - pr, y1: y(g).toFixed(1), y2: y(g).toFixed(1) });
      s += svgEl("text", { "class": "axis", x: pl - 8, y: (y(g) + 4).toFixed(1), "text-anchor": "end" }, esc(money0(g)));
    }
    var path = H.map(function (h, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(h.total).toFixed(1); }).join("");
    if (H.length > 1) s += svgEl("path", { "class": "series" + (anim && motion() ? " draw" : ""), d: path });
    if (H.length <= 40) H.forEach(function (h, i) { s += svgEl("circle", { "class": "pt", cx: x(i).toFixed(1), cy: y(h.total).toFixed(1), r: H.length === 1 ? 4 : 2.5 }, "<title>" + esc(h.date + ": " + money(h.total)) + "</title>"); });
    var idx = H.length <= 2 ? H.map(function (_, i) { return i; }) : [0, Math.floor((H.length - 1) / 2), H.length - 1];
    idx.forEach(function (i) {
      var anchor = H.length > 2 && i === 0 ? "start" : H.length > 2 && i === H.length - 1 ? "end" : "middle";
      s += svgEl("text", { "class": "axis", x: x(i).toFixed(1), y: Ht - 8, "text-anchor": anchor }, esc(fmtDate(H[i].date, { month: "short", day: "numeric", year: "numeric" })));
    });
    s += "</svg>";
    el.innerHTML = s;
    var st = d.stats || {}, first = H[0], last = H[H.length - 1];
    var chg = last.total - first.total;
    var foot = H.length + " trading day" + (H.length === 1 ? "" : "s") + " recorded";
    if (H.length > 1) {
      foot += " · change since " + fmtDate(first.date, { month: "short", day: "numeric", year: "numeric" }) + ": " + sMoney(chg) + " (" + sPct(chg / first.total * 100) + ")";
      if (isNum(st.all_time_high)) foot += " · high " + money(st.all_time_high);
    } else {
      foot += " (" + money(last.total) + " on " + fmtDate(last.date, { month: "short", day: "numeric", year: "numeric" }) + "). The line fills in as each trading day is added.";
    }
    $("chart-foot").textContent = foot;
  }

  // ------------------------------------------------------------------ paper trading
  function renderPaper(d) {
    var P = d.paper, panel = $("paper-panel");
    if (!P || !P.champion || !P.buy_hold) { panel.hidden = true; return; }
    panel.hidden = false;
    var C = P.champion, B = P.buy_hold, R = P.readiness || {}, WF = P.walk_forward || {};
    function row(name, f) {
      var ret = isNum(f.return) ? f.return * 100 : null;
      var posTxt = esc(f.position || "n/a");
      return "<tr><td>" + esc(name) + '<div class="subtle show-m">Position: ' + posTxt + "</div></td>" +
        '<td class="num">' + money0(f.equity) + '</td><td class="num"><span class="' + cls(ret) + '">' + sPct(ret) + "</span></td>" +
        '<td class="num">' + (isNum(f.max_dd) ? pct(f.max_dd * 100, 1) : "n/a") + '</td><td class="hide-m">' + posTxt + "</td></tr>";
    }
    var html = '<p class="paper-meta">Trend strategy: ' + esc(C.label || C.id) + ". Started " + esc(P.start_date ? fmtDate(P.start_date, { month: "short", day: "numeric", year: "numeric" }) : "n/a") +
      " · " + (P.forward_days || 0) + " forward trading day" + (P.forward_days === 1 ? "" : "s") +
      " · data through " + esc(P.data_through || "n/a") + (isNum(P.spy_close) ? " · SPY close " + money(P.spy_close) : "") + "</p>";
    html += '<div class="table-scroll"><table class="data compact"><thead><tr><th>Strategy</th><th class="num">Value</th><th class="num">Return</th><th class="num">Max drawdown</th><th class="hide-m">Position</th></tr></thead><tbody>' +
      row("Trend strategy", C) + row("Buy-and-hold SPY", B) + "</tbody></table></div>";
    if (C.target_next) html += '<p class="note">Next session target for the trend strategy: ' + esc(C.target_next) + (P.signal_change ? " (" + esc(P.signal_change) + ")" : "") + ".</p>";
    if (P.forward_note) html += '<p class="note">' + esc(P.forward_note.charAt(0).toUpperCase() + P.forward_note.slice(1)) + ".</p>";

    var crit = (R.criteria || []).map(function (c) {
      return "<tr><td>" + esc(c.description) + '<div class="subtle">Needs ' + esc(c.threshold) + " · now " + esc(c.current) + "</div></td>" +
        '<td class="num ' + (c.pass ? "crit-ok" : "crit-no") + '">' + (c.pass ? "Met" : "Not met") + "</td></tr>";
    }).join("");
    var status = String(R.status || "n/a").toLowerCase();
    status = status.charAt(0).toUpperCase() + status.slice(1);
    html += '<div class="paper-cols"><div><h3>Readiness for real money: <span class="ready-status">' + esc(status) + "</span> (criteria met " +
      (R.passed != null ? R.passed : "?") + " of " + (R.total != null ? R.total : "?") + ")</h3>" +
      '<div class="table-scroll"><table class="data compact"><tbody>' + crit + "</tbody></table></div></div>";
    var wfRows = [
      ["Annual return (CAGR)", isNum(WF.oos_cagr) ? pct(WF.oos_cagr * 100, 1) : "n/a", isNum(WF.oos_bh_cagr) ? pct(WF.oos_bh_cagr * 100, 1) : "n/a"],
      ["Sharpe ratio", isNum(WF.oos_sharpe) ? WF.oos_sharpe.toFixed(2) : "n/a", isNum(WF.oos_bh_sharpe) ? WF.oos_bh_sharpe.toFixed(2) : "n/a"],
      ["Max drawdown", isNum(WF.oos_max_dd) ? pct(WF.oos_max_dd * 100, 1) : "n/a", isNum(WF.oos_bh_max_dd) ? pct(WF.oos_bh_max_dd * 100, 1) : "n/a"]
    ].map(function (r) { return "<tr><td>" + r[0] + '</td><td class="num">' + r[1] + '</td><td class="num">' + r[2] + "</td></tr>"; }).join("");
    html += "<div><h3>Historical walk-forward test" + (isNum(WF.oos_years) ? " (" + WF.oos_years.toFixed(1) + " years, out of sample)" : "") + "</h3>" +
      '<div class="table-scroll"><table class="data compact"><thead><tr><th></th><th class="num">Trend</th><th class="num">Buy-and-hold</th></tr></thead><tbody>' + wfRows + "</tbody></table></div>" +
      '<p class="note">Windows won: ' + esc(WF.windows_won || "n/a") + (WF.overfit_flag ? " · flagged for possible overfitting" : "") + ".</p>" +
      ((R.notes || []).length ? '<p class="note">' + esc(R.notes[0]) + "</p>" : "") + "</div></div>";
    $("paper").innerHTML = html;
  }

  // ================================================================== Stocks view (iOS Stocks-style)
  var BASE_URL = STANDALONE ? (CFG.remoteUrl ? CFG.remoteUrl.replace(/data\/portfolio\.json.*$/, "") : "") : "";
  var CAN_FETCH_EXTRA = !STANDALONE || !!BASE_URL;
  var RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"];
  var RANGE_WORDS = { "1D": "today", "1W": "past week", "1M": "past month", "3M": "past 3 months", "1Y": "past year", "ALL": "all time" };
  var PILL_MODES = ["pct", "chg", "val"];
  var ui = {
    view: null, sel: null, pill: lsGet("pq-pill", "pct"), range: lsGet("pq-range", "1D"), acRange: lsGet("pq-ac-range", "1D"),
    charts: {}, tx: null, txAt: 0,
    listShown: false, pillSwap: false, rowFrom: null, lastPrices: null, animFrom: null, lastTotal: null, closeTok: 0
  };
  if (PILL_MODES.indexOf(ui.pill) < 0) ui.pill = "pct";
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function abbr(x, cur) {
    if (!isNum(x)) return "n/a";
    var a = Math.abs(x), s = (x < 0 ? "−" : "") + (cur ? "$" : "");
    if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e3 && !cur) return s + (a / 1e3).toFixed(1) + "K";
    return cur ? money(x) : qty(x);
  }
  function fmtTime(ts, withDate) {
    var o = { timeZone: TZ, hour: "numeric", minute: "2-digit" };
    if (withDate) { o.month = "short"; o.day = "numeric"; }
    return new Intl.DateTimeFormat("en-US", o).format(new Date(ts * 1000));
  }
  function fmtDay(ts, opts) {
    opts = opts || { month: "short", day: "numeric", year: "numeric" }; opts.timeZone = TZ;
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(ts * 1000));
  }

  // Rows shown in the list: held stocks, options, then watchlist symbols not held.
  function stockRows(d) {
    var Q = d.quotes || {}, rows = [], a = d.account || {};
    (d.positions || []).forEach(function (p) {
      var q = Q[p.symbol] || {};
      rows.push({ id: p.symbol, sym: p.symbol, name: p.name, kind: "stock", held: true, q: q, pos: p,
        price: p.price, chg: p.day_change_per_share, pct: p.day_change_pct, value: p.value, cap: null,
        spark: q.spark || [], base: isNum(q.spark_base) ? q.spark_base : p.prev_close });
    });
    (d.options || []).forEach(function (o) {
      var id = o.contract || o.key, q = Q[id] || {};
      var chg = isNum(o.prev_mark) ? o.mark - o.prev_mark : null;
      rows.push({ id: id, sym: q.display || (o.underlying + " " + o.strike + (o.type === "call" ? "C" : "P")),
        name: (o.position === "short" ? "Short " : "Long ") + o.contracts + " · " + fmtDate(o.expiry, { month: "short", day: "numeric", year: "numeric" }) + " " + o.type +
          (o.position === "short" ? " · you gain when price falls" : ""),
        sign: o.position === "short" ? -1 : 1, posDay: o.day_change,
        kind: "option", held: true, q: q, opt: o, price: o.mark, chg: chg, pct: isNum(chg) && o.prev_mark ? chg / o.prev_mark * 100 : null,
        value: o.liability, spark: q.spark || [], base: o.prev_mark });
    });
    var watch = [];
    (d.watchlist || []).forEach(function (sym) {
      var q = Q[sym];
      if (!q) { watch.push({ id: sym, sym: sym, name: "No quote right now", kind: "stock", held: false, q: {}, missing: true }); return; }
      watch.push({ id: sym, sym: sym, name: q.name, kind: "stock", held: !!q.held, q: q, price: q.price, chg: q.change, pct: q.change_pct,
        value: null, cap: (q.stats || {}).market_cap || (q.stats || {}).net_assets, spark: q.spark || [], base: q.spark_base });
    });
    void a;
    return { held: rows, watch: watch };
  }
  function findRow(d, id) {
    var r = stockRows(d), all = r.held.concat(r.watch);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function sparkSvg(pts, base, sign, delay) {
    var W = 64, H = 30, P = 2;
    if (!pts || pts.length < 2) return '<svg class="spark" viewBox="0 0 64 30" aria-hidden="true"><line class="sp-base" x1="0" x2="64" y1="15" y2="15"/></svg>';
    var vals = pts.map(function (p) { return p[1]; });
    if (isNum(base)) vals.push(base);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var span = Math.max(390, pts[pts.length - 1][0]);
    function x(m) { return (m / span * W).toFixed(1); }
    function y(v) { return (P + (1 - (v - mn) / (mx - mn)) * (H - 2 * P)).toFixed(1); }
    var last = pts[pts.length - 1][1], up = !isNum(base) || (sign === -1 ? last <= base : last >= base);
    var path = pts.map(function (p, i) { return (i ? "L" : "M") + x(p[0]) + "," + y(p[1]); }).join("");
    var drawCls = isNum(delay) && motion() ? " draw" : "", st = drawCls ? ' style="animation-delay:' + delay + 'ms"' : "";
    return '<svg class="spark ' + (up ? "up" : "down") + drawCls + '"' + st + ' viewBox="0 0 64 30" preserveAspectRatio="none" aria-hidden="true">' +
      (isNum(base) ? '<line class="sp-base" x1="0" x2="64" y1="' + y(base) + '" y2="' + y(base) + '"/>' : "") +
      '<path class="sp-line" d="' + path + '"/></svg>';
  }
  function pillText(r) {
    if (ui.pill === "chg") { if (r.kind === "option") return isNum(r.posDay) ? sMoney(r.posDay) : "n/a"; return isNum(r.chg) ? sMoney(r.chg) : "n/a"; }
    if (ui.pill === "val") return r.held ? money(r.value) : (isNum(r.cap) ? abbr(r.cap, true) : "n/a");
    return isNum(r.pct) ? sPct(r.pct) : "n/a";
  }
  function pillTitle() { return ui.pill === "chg" ? "Day change ($)" : ui.pill === "val" ? "Market value (market cap for watchlist)" : "Day change (%)"; }
  function rowHtml(r, i, stag) {
    var pl = isNum(r.chg) ? r.chg * (r.sign || 1) : null;  // P/L impact to him (short: price up = loss)
    var dir = isNum(pl) ? (pl > 0 ? "up" : pl < 0 ? "down" : "flat") : "flat";
    var li = stag ? '<li class="row-in" style="animation-delay:' + (i * 45) + 'ms">' : "<li>";
    return li + '<div class="srow' + (ui.sel === r.id ? " sel" : "") + '" role="button" tabindex="0" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '">' +
      '<div class="s-left"><div class="s-sym">' + esc(r.sym) + '</div><div class="s-name">' + esc(r.name || "") + "</div></div>" +
      '<div class="s-mid">' + (r.missing ? "" : sparkSvg(r.spark, r.base, r.sign, stag ? i * 45 + 140 : null)) + "</div>" +
      '<div class="s-right"><div class="s-price">' + (r.missing ? "" : money(r.price)) + "</div>" +
      (r.missing ? "" : '<button type="button" class="pill ' + dir + '" data-pill="1" title="' + esc(pillTitle()) + '"><span class="pv"><span class="pt' + (ui.pillSwap && motion() ? " swap" : "") + '">' + esc(pillText(r)) + "</span></span></button>") +
      "</div></div></li>";
  }
  function renderStocks(d) {
    var a = d.account || {}, rows = stockRows(d);
    $("s-total").textContent = money(a.total);
    if (isNum(ui.animFrom) && isNum(a.total) && Math.abs(ui.animFrom - a.total) > 0.004) {
      countUp($("s-total"), ui.animFrom, a.total, money); flash($("s-total"), a.total > ui.animFrom, true);
    }
    var day = $("s-day");
    day.innerHTML = '<span class="' + cls(a.day_change) + '">' + sMoney(a.day_change) + " (" + sPct(a.day_change_pct) + ")</span> <span class=\"subtle\">today</span>";
    var o = (d.options || [])[0];
    $("s-sub").textContent = "Stocks " + money(a.stocks_value) + " · Cash " + money(a.cash) +
      (o ? " · Short call " + money(a.option_liability) : "") + " · " + (d.market_label || "") + ", as of " + (d.quotes_as_of_et || "n/a");
    var stag = ui.view === "stocks" && !ui.listShown && motion(), nh = rows.held.length;
    if (ui.view === "stocks") ui.listShown = true;
    $("s-held").innerHTML = rows.held.map(function (r, i) { return rowHtml(r, i, stag); }).join("");
    $("s-watch").innerHTML = rows.watch.length ? rows.watch.map(function (r, i) { return rowHtml(r, nh + i, stag); }).join("") : '<li class="note s-empty">No watchlist symbols. Add some under Edit.</li>';
    // price cells: count to the new value and flash green/red when it changed since the last refresh
    if (ui.rowFrom) rows.held.concat(rows.watch).forEach(function (r) {
      var p = ui.rowFrom[r.id];
      if (!isNum(p) || !isNum(r.price) || Math.abs(p - r.price) < 1e-9) return;
      var row = document.querySelector('.srow[data-id="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"] .s-price');
      if (!row) return;
      countUp(row, p, r.price, money, 650);
      flash(row, (r.price - p) * (r.sign || 1) > 0);
    });
    if (ui.view === "stocks") {
      renderRanges("ac-ranges", ui.acRange, chartFor("ACCOUNT"));
      drawAccount("morph");
      if (ui.sel) renderDetail(d, "morph");
      else if (wide()) { var first = rows.held[0] || rows.watch[0]; if (first) openDetail(first.id, true); }
    }
  }

  // ---------------------------------------------------------------- charts (data/charts/<SYM>.json)
  function chartUrl(id, row) {
    if (id === "ACCOUNT") return BASE_URL + "data/charts/_account.json";
    var u = row && row.q && row.q.chart;
    return u ? BASE_URL + u : null;
  }
  function chartFor(id) { return (ui.charts[id] || {}).data || null; }
  function loadChart(id, row, force) {
    var c = ui.charts[id] || (ui.charts[id] = {});
    var url = chartUrl(id, row);
    if (!url || !CAN_FETCH_EXTRA) { c.failed = true; return Promise.resolve(null); }
    if (c.loading) return c.loading;
    if (!force && c.data && Date.now() - c.at < REFRESH_MS - 2000) return Promise.resolve(c.data);
    c.loading = fetchAny(url).then(function (j) { c.data = j; c.at = Date.now(); c.failed = false; return j; })
      .catch(function () { c.failed = true; return c.data || null; })
      .then(function (j) { c.loading = null; return j; });
    return c.loading;
  }
  function fetchAny(url) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
    return fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { clearTimeout(to); });
  }
  // Segmented range control. Buttons are built once; a single indicator slides to the active one.
  function renderRanges(elId, active, chart) {
    var box = $(elId), R = (chart && chart.ranges) || {}, on = null;
    if (!box._built) {
      box.innerHTML = '<span class="rg-ind" aria-hidden="true"></span>' +
        RANGES.map(function (k) { return '<button type="button" data-range="' + k + '">' + k + "</button>"; }).join("");
      box._built = true;
    }
    var btns = box.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var k = btns[i].getAttribute("data-range"), has = !chart || !!R[k];
      btns[i].disabled = !has;
      btns[i].classList.toggle("on", k === active);
      btns[i].setAttribute("aria-pressed", k === active ? "true" : "false");
      if (k === active) on = btns[i];
    }
    placeInd(box, on);
  }
  function placeInd(box, on) {
    var ind = box.querySelector(".rg-ind");
    if (!ind) return;
    if (!on || !box.offsetWidth) { ind.style.opacity = "0"; box._indPlaced = false; return; }
    var first = !box._indPlaced || !motion();
    if (first) ind.style.transition = "none";
    ind.style.width = on.offsetWidth + "px";
    ind.style.transform = "translateX(" + on.offsetLeft + "px)";
    ind.style.opacity = "1";
    if (first) { void ind.offsetWidth; ind.style.transition = ""; box._indPlaced = true; }
  }
  function chartH(el) { return (el.clientWidth || 600) < 500 ? 210 : 260; }
  function chartSkeleton(el) { el.innerHTML = '<div class="sk-chart" aria-hidden="true" style="height:' + chartH(el) + 'px"></div>'; }

  // Price chart: line (green/red vs the range's starting value), dashed baseline, right-hand price axis,
  // and a crosshair readout on hover/touch (exact time and value).
  // opts.anim: "draw" (line draws in left to right), "morph" (line morphs from the previous one), or none.
  function priceChart(el, readout, rg, opts) {
    opts = opts || {};
    var cw = el.clientWidth;
    if (!cw) { el._sig = null; return; }  // hidden: drawn when shown
    if (!rg || !rg.t || rg.t.length < 1) { el._sig = null; el._line = null; el.innerHTML = '<p class="note chart-empty" style="min-height:' + chartH(el) + 'px">' + esc(opts.empty || "No chart data for this range.") + "</p>"; readout.innerHTML = "&nbsp;"; return; }
    var T = rg.t, V = rg.v, n = T.length, base = rg.base;
    var W = Math.max(280, Math.round(cw)), H = opts.height || (W < 500 ? 210 : 260);
    var sig = [opts.rangeKey, opts.sign, opts.label, W, n, T[0], T[n - 1], V[n - 1], base].join("|");
    var anim = motion() ? opts.anim : null;
    if (sig === el._sig && el.querySelector("svg")) { if (anim !== "draw") return; }
    var pl = 6, pr = W < 500 ? 58 : 70, pt = 10, pb = 24;
    var vals = V.filter(isNum).concat(isNum(base) ? [base] : []);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx - mn < 1e-9) { mx += Math.max(Math.abs(mx) * 0.01, 0.01); mn -= Math.max(Math.abs(mn) * 0.01, 0.01); }
    var padv = (mx - mn) * 0.08; mn -= padv; mx += padv;
    var timeScale = !!(rg.session_open && rg.session_close);
    function x(i) {
      if (timeScale) return pl + Math.min(1, Math.max(0, (T[i] - rg.session_open) / (rg.session_close - rg.session_open))) * (W - pl - pr);
      return n <= 1 ? (pl + W - pr) / 2 : pl + i / (n - 1) * (W - pl - pr);
    }
    function y(v) { return pt + (1 - (v - mn) / (mx - mn)) * (H - pt - pb); }
    var sg = opts.sign === -1 ? -1 : 1;
    var last = V[n - 1], up = !isNum(base) || (sg < 0 ? last <= base : last >= base);
    var pts = [];
    for (var pi = 0; pi < n; pi++) if (isNum(V[pi])) pts.push([x(pi), y(V[pi])]);
    if (anim === "morph" && !(el._line && el._line.length > 1 && el._W === W && pts.length > 1)) anim = el._line ? null : "draw";
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="' + (up ? "up" : "down") + (anim ? " fade" : "") + '" role="img" aria-label="' + esc(opts.label || "Price chart") + '">';
    var step = niceStep(mx - mn, 4);
    for (var g = Math.ceil(mn / step) * step; g <= mx; g += step) {
      s += svgEl("line", { "class": "gridline", x1: pl, x2: W - pr, y1: y(g).toFixed(1), y2: y(g).toFixed(1) });
      s += svgEl("text", { "class": "axis", x: W - pr + 6, y: (y(g) + 4).toFixed(1) }, esc(opts.axisFmt ? opts.axisFmt(g) : money(g).replace(/\.00$/, "")));
    }
    if (isNum(base) && opts.showBase !== false) s += svgEl("line", { "class": "baseline", x1: pl, x2: W - pr, y1: y(base).toFixed(1), y2: y(base).toFixed(1) });
    var path = "";
    for (var i = 0; i < n; i++) if (isNum(V[i])) path += (path ? "L" : "M") + x(i).toFixed(1) + "," + y(V[i]).toFixed(1);
    if (n > 1) {
      s += '<g class="plot' + (anim === "draw" ? " draw" : "") + '">';
      s += svgEl("path", { "class": "area", d: path + "L" + x(n - 1).toFixed(1) + "," + (H - pb) + "L" + x(0).toFixed(1) + "," + (H - pb) + "Z" });
      s += svgEl("path", { "class": "pline", d: path });
      s += "</g>";
    } else {
      s += svgEl("circle", { "class": "pdot", cx: x(0).toFixed(1), cy: y(V[0]).toFixed(1), r: 3 });
    }
    // x labels
    var labels = [];
    if (timeScale) {
      [10, 12, 14].forEach(function (h) { var t = rg.session_open + (h * 60 - 570) * 60; labels.push([pl + (t - rg.session_open) / (rg.session_close - rg.session_open) * (W - pl - pr), fmtTime(t).replace(":00", "")]); });
    } else if (n > 1) {
      var lastKey = null, cand = [];
      for (var j = 0; j < n; j++) {
        var key = rg.interval && /m$/.test(rg.interval) ? fmtDay(T[j], { weekday: "short" }) :
          (opts.rangeKey === "1Y" ? fmtDay(T[j], { month: "short" }) : opts.rangeKey === "ALL" ? fmtDay(T[j], { year: "numeric" }) : fmtDay(T[j], { month: "short", day: "numeric" }));
        if (key !== lastKey) { cand.push([x(j), key]); lastKey = key; }
      }
      var maxLabels = W < 500 ? 4 : 6, every = Math.ceil(cand.length / maxLabels);
      labels = cand.filter(function (_, k) { return k % every === 0; });
    }
    labels.forEach(function (L) { if (L[0] < W - pr - 10) s += svgEl("text", { "class": "axis", x: Math.max(L[0], pl).toFixed(1), y: H - 6, "text-anchor": L[0] < pl + 18 ? "start" : "middle" }, esc(L[1])); });
    s += '<line class="xhair" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" visibility="hidden"/><circle class="xdot" r="4" cx="0" cy="0" visibility="hidden"/>';
    s += svgEl("rect", { "class": "hit", x: 0, y: 0, width: W, height: H, fill: "transparent" });
    s += "</svg>";
    var oldLine = el._line;
    el.innerHTML = s;
    el._sig = sig; el._line = pts; el._W = W;
    if (anim === "morph" && n > 1) morphLine(el, oldLine, pts, H - pb);
    var rangeTxt = opts.rangeText || "";
    var first = isNum(base) ? base : V[0], ch = last - first;
    var idle = '<span class="' + cls(ch * sg) + '">' + sMoney(ch) + " (" + sPct(first ? ch / first * 100 : null) + ")</span> " + esc(rangeTxt);
    readout.innerHTML = idle;
    var svg = el.querySelector("svg"), xl = svg.querySelector(".xhair"), xd = svg.querySelector(".xdot");
    function at(ev) {
      var rect = svg.getBoundingClientRect(), px = (ev.clientX - rect.left) * (W / rect.width);
      var bi = 0, bd = Infinity;
      for (var k = 0; k < n; k++) { var dd = Math.abs(x(k) - px); if (dd < bd) { bd = dd; bi = k; } }
      return bi;
    }
    var shown = false;
    function show(ev) {
      if (!n) return;
      var k = at(ev), v = V[k];
      if (!isNum(v)) return;
      // crosshair glides between points (CSS transition on transform); jumps straight there on first show
      if (!shown) { xl.classList.add("snap"); xd.classList.add("snap"); }
      xl.style.transform = "translate(" + x(k).toFixed(1) + "px,0)";
      xd.style.transform = "translate(" + x(k).toFixed(1) + "px," + y(v).toFixed(1) + "px)";
      xl.setAttribute("visibility", "visible"); xd.setAttribute("visibility", "visible");
      if (!shown) { void xl.getBoundingClientRect(); xl.classList.remove("snap"); xd.classList.remove("snap"); shown = true; }
      var intra = rg.interval && /m$/.test(rg.interval);
      var when = intra ? fmtTime(T[k], !timeScale) + " ET" : fmtDay(T[k], { month: "short", day: "numeric", year: "numeric" });
      var c = v - first;
      readout.innerHTML = "<strong>" + esc(opts.valFmt ? opts.valFmt(v) : money(v)) + '</strong> <span class="' + cls(c * sg) + '">' + sMoney(c) + " (" + sPct(first ? c / first * 100 : null) + ")</span> " +
        '<span class="subtle">' + esc(when) + "</span>";
    }
    function hide() { shown = false; xl.setAttribute("visibility", "hidden"); xd.setAttribute("visibility", "hidden"); readout.innerHTML = idle; }
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("pointercancel", hide);
    svg.addEventListener("pointerup", function (ev) { if (ev.pointerType !== "mouse") setTimeout(hide, 1500); });
  }

  // Resample a polyline to N points evenly spaced in x (for morphing between ranges).
  function resample(P, N) {
    var out = [], x0 = P[0][0], x1 = P[P.length - 1][0], j = 0;
    for (var k = 0; k < N; k++) {
      var xs = x0 + (x1 - x0) * k / (N - 1);
      while (j < P.length - 2 && P[j + 1][0] < xs) j++;
      var p = P[j], q = P[Math.min(j + 1, P.length - 1)], f = q[0] === p[0] ? 0 : (xs - p[0]) / (q[0] - p[0]);
      f = Math.max(0, Math.min(1, f));
      out.push([xs, p[1] + (q[1] - p[1]) * f]);
    }
    return out;
  }
  function morphLine(el, from, to, bottom) {
    var line = el.querySelector(".pline"), area = el.querySelector(".area");
    if (!line || !from || from.length < 2) return;
    var N = 160, A = resample(from, N), B = resample(to, N), dLine = line.getAttribute("d"), dArea = area ? area.getAttribute("d") : null;
    var t0 = null, dur = 420, tok = (el._mt || 0) + 1; el._mt = tok;
    function frame(ts) {
      if (el._mt !== tok || !line.isConnected) return;
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), e = easeIO(k);
      if (k >= 1) { line.setAttribute("d", dLine); if (area) area.setAttribute("d", dArea); return; }
      var d = "";
      for (var i = 0; i < N; i++) d += (i ? "L" : "M") + (A[i][0] + (B[i][0] - A[i][0]) * e).toFixed(1) + "," + (A[i][1] + (B[i][1] - A[i][1]) * e).toFixed(1);
      line.setAttribute("d", d);
      if (area) {
        var xa = A[0][0] + (B[0][0] - A[0][0]) * e, xb = A[N - 1][0] + (B[N - 1][0] - A[N - 1][0]) * e;
        area.setAttribute("d", d + "L" + xb.toFixed(1) + "," + bottom + "L" + xa.toFixed(1) + "," + bottom + "Z");
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function drawAccount(anim) {
    var c = chartFor("ACCOUNT");
    var el = $("ac-chart"), ro = $("ac-readout");
    if (!c) {
      if (CAN_FETCH_EXTRA) chartSkeleton(el); else el.innerHTML = '<p class="note chart-empty">Charts aren\'t included in the offline snapshot.</p>';
      if (CAN_FETCH_EXTRA) loadChart("ACCOUNT", null).then(function (j) { if (j) { renderRanges("ac-ranges", ui.acRange, j); drawAccount("draw"); } else el.innerHTML = '<p class="note chart-empty">Account chart not available yet.</p>'; });
      return;
    }
    var R = c.ranges || {};
    if (!R[ui.acRange]) ui.acRange = R["1D"] ? "1D" : Object.keys(R)[0];
    var rg = R[ui.acRange];
    priceChart(el, ro, rg, { anim: anim, label: "Account value", rangeKey: ui.acRange, rangeText: RANGE_WORDS[ui.acRange],
      axisFmt: function (g) { return money0(g); }, empty: "No account history for this range yet." });
    var daily = rg && rg.interval && !/m$/.test(rg.interval);
    $("ac-note").textContent = (daily && rg.t.length < 5 ? "Only " + rg.t.length + " trading day" + (rg.t.length === 1 ? "" : "s") + " recorded so far; longer ranges fill in over time. " : "") + (c.note || "");
  }

  // ---------------------------------------------------------------- detail panel
  function wide() { return window.matchMedia && window.matchMedia("(min-width: 960px)").matches; }
  function openDetail(id, quiet) {
    if (!id) return;
    var fresh = ui.sel !== id;
    if (fresh) $("detail").scrollTop = 0;
    cancelClose();
    ui.sel = id;
    var want = "#stocks/" + encodeURIComponent(id);
    if (!quiet && location.hash !== want) {
      if (wide() || /^#stocks\//.test(location.hash)) history.replaceState(history.state, "", want); else history.pushState({ sheet: 1 }, "", want);
    }
    renderDetail(state.data, fresh ? "draw" : "morph");
    markSelected();
  }
  // Phones: the sheet slides down before it is hidden. Wide screens: hidden at once.
  function closeDetail(fromNav) {
    if (!ui.sel) return;
    ui.sel = null;
    var panel = $("detail");
    if (!wide() && motion() && !panel.hidden) {
      var tok = ++ui.closeTok;
      panel.classList.add("closing");
      document.body.classList.add("sheet-closing");
      setTimeout(function () { if (ui.closeTok === tok) finishClose(); }, 270);
    } else finishClose();
    markSelected();
    if (!fromNav && /^#stocks\//.test(location.hash)) {
      if (history.state && history.state.sheet) history.back(); else history.replaceState(null, "", "#stocks");
    }
  }
  function finishClose() {
    var panel = $("detail");
    if (ui.sel) return;
    panel.hidden = true;
    panel.classList.remove("closing", "dragging");
    panel.style.transform = ""; panel.style.transition = "";
    document.body.classList.remove("sheet-open", "sheet-closing");
  }
  function cancelClose() {
    ui.closeTok++;
    var panel = $("detail");
    panel.classList.remove("closing");
    panel.style.transform = ""; panel.style.transition = "";
    document.body.classList.remove("sheet-closing");
  }
  // Swipe down on the sheet's top bar (or anywhere when scrolled to the top) to close it.
  function sheetSwipeInit() {
    var panel = $("detail"), drag = null;
    panel.addEventListener("touchstart", function (e) {
      if (wide() || e.touches.length !== 1 || panel.hidden) return;
      var inBar = !!(e.target.closest && e.target.closest(".detail-bar"));
      if (!inBar && (panel.scrollTop > 0 || (e.target.closest && e.target.closest(".pchart, .ranges")))) return;
      drag = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, t0: Date.now(), dy: 0, bar: inBar, on: false };
    }, { passive: true });
    panel.addEventListener("touchmove", function (e) {
      if (!drag) return;
      var dy = e.touches[0].clientY - drag.y0, dx = Math.abs(e.touches[0].clientX - drag.x0);
      if (!drag.on) {
        if (dy > 6 && dy > dx && (drag.bar || panel.scrollTop <= 0)) { drag.on = true; drag.t0 = Date.now(); panel.classList.add("dragging"); }
        else if (dy < -6 || dx > 10) { drag = null; return; }
        else return;
      }
      e.preventDefault();
      drag.dy = Math.max(0, dy);
      panel.style.transform = "translateY(" + drag.dy.toFixed(1) + "px)";
    }, { passive: false });
    function end() {
      if (!drag) return;
      var d = drag; drag = null;
      if (!d.on) return;
      var v = d.dy / Math.max(1, Date.now() - d.t0);
      panel.classList.remove("dragging");
      if (d.dy > 110 || (v > 0.5 && d.dy > 30)) {
        closeDetail();                 // adds .closing (transition), then let it run from the dragged position
        panel.style.transform = "";
        if (panel.hidden || !panel.classList.contains("closing")) finishClose();
      } else {
        panel.style.transition = "transform .45s var(--spring)";
        panel.style.transform = "";
        setTimeout(function () { panel.style.transition = ""; }, 460);
      }
    }
    panel.addEventListener("touchend", end);
    panel.addEventListener("touchcancel", end);
    $("sheet-backdrop").addEventListener("click", function () { closeDetail(); });
  }
  function markSelected() {
    var els = document.querySelectorAll(".srow");
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("sel", els[i].getAttribute("data-id") === ui.sel);
  }
  function stat(k, v) { return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>"; }
  function renderDetail(d, anim) {
    if (!d || !ui.sel) return;
    var r = findRow(d, ui.sel), panel = $("detail");
    if (!r) { closeDetail(true); return; }
    panel.hidden = false;
    if (!wide()) document.body.classList.add("sheet-open");
    $("d-sym").textContent = r.sym;
    $("d-name").textContent = r.kind === "option" ? r.opt.label : (r.q.long_name || r.name || "");
    $("d-price").textContent = r.missing ? "No quote" : money(r.price);
    var pf = ui.rowFrom && ui.rowFrom[r.id];
    if (!r.missing && isNum(pf) && isNum(r.price) && Math.abs(pf - r.price) > 1e-9) {
      countUp($("d-price"), pf, r.price, money); flash($("d-price"), (r.price - pf) * (r.sign || 1) > 0, true);
    }
    $("d-chg").innerHTML = r.missing ? "" : '<span class="' + cls(isNum(r.chg) ? r.chg * (r.sign || 1) : null) + '">' + sMoney(r.chg) + " (" + sPct(r.pct) + ")</span> <span class=\"subtle\">today" +
      (r.kind === "option" ? ", per share" + (r.sign === -1 ? '</span> <span class="subtle">· your P/L </span><span class="' + cls(r.posDay) + '">' + sMoney(r.posDay) + "</span>" : "</span>") : "</span>");
    $("d-asof").textContent = r.kind === "option" ? "Mark: " + (r.opt.quote_reused ? "last good bid/ask mid" : (r.opt.mark_source || "")) + (d.quotes_as_of_et ? " · as of " + d.quotes_as_of_et : "") :
      ((r.q.quote_time_et ? "As of " + r.q.quote_time_et : "") + (r.q.exchange ? " · " + r.q.exchange : "") + (d.market_label ? " · " + d.market_label : ""));
    // stats
    var st = r.q.stats || {}, html = "";
    if (r.kind === "option") {
      var o = r.opt;
      html = stat("Bid / ask", isNum(o.bid) && isNum(o.ask) ? money(o.bid) + " / " + money(o.ask) : "n/a") + stat("Mark", money(o.mark)) +
        stat("Prev mark", money(o.prev_mark)) + stat("Last trade", isNum(o.last) ? money(o.last) : "n/a") +
        stat("Strike", money(o.strike)) + stat("Expiry", esc(fmtDate(o.expiry, { month: "short", day: "numeric", year: "numeric" }))) +
        stat("Days to expiry", o.expired ? "expired" : String(o.dte)) + stat(o.underlying + " price", money(o.spot)) +
        stat("Moneyness", (o.itm ? "In" : "Out of") + " the money") + stat("Implied vol.", isNum(o.iv) ? pct(o.iv * 100, 1) : "n/a") +
        stat("Open interest", isNum(o.open_interest) ? qty(o.open_interest) : "n/a") + stat("Volume", isNum(o.volume) ? qty(o.volume) : "n/a");
    } else if (!r.missing) {
      html = stat("Open", money(st.open)) + stat("High", money(st.day_high)) + stat("Low", money(st.day_low)) +
        stat("Prev close", money(r.q.prev_close)) + stat("52-wk high", money(st.high_52w)) + stat("52-wk low", money(st.low_52w)) +
        stat("Volume", abbr(st.volume)) + stat("Avg volume", abbr(st.avg_volume)) +
        (isNum(st.market_cap) ? stat("Market cap", abbr(st.market_cap, true)) : isNum(st.net_assets) ? stat("Net assets", abbr(st.net_assets, true)) : stat("Market cap", "n/a"));
    }
    $("d-stats").innerHTML = html;
    // position
    var ph = "", note = "";
    if (r.kind === "stock" && r.pos) {
      var p = r.pos;
      ph = stat("Shares", qty(p.shares)) + stat("Avg cost", isNum(p.avg_cost) ? money(p.avg_cost) : "not set") +
        stat("Market value", money(p.value)) + stat("Day gain", '<span class="' + cls(p.day_change) + '">' + sMoney(p.day_change) + "</span>") +
        stat("Cost basis", isNum(p.cost_basis) ? money(p.cost_basis) : "n/a") +
        stat("Unrealized P/L", isNum(p.unrealized) ? '<span class="' + cls(p.unrealized) + '">' + sMoney(p.unrealized) + " (" + sPct(p.unrealized_pct) + ")</span>" : "n/a") +
        stat("% of portfolio", pct(p.share_pct));
      if (!isNum(p.avg_cost)) note = "Average cost isn't recorded yet. Add it under Edit > Set cost basis to see unrealized P/L.";
    } else if (r.kind === "option") {
      var oo = r.opt, n = oo.contracts;
      ph = stat("Position", esc((oo.position === "short" ? "Short " : "Long ") + n + " contract" + (n === 1 ? "" : "s"))) +
        stat("Shares covered", String(oo.shares_at_risk || n * oo.multiplier)) + stat("Opened at", isNum(oo.open_price) ? money(oo.open_price) + " / share" : "not set") +
        stat("Market value", money(oo.liability)) + stat("Day gain", '<span class="' + cls(oo.day_change) + '">' + sMoney(oo.day_change) + "</span>") +
        stat("Unrealized P/L", isNum(oo.unrealized) ? '<span class="' + cls(oo.unrealized) + '">' + sMoney(oo.unrealized) + "</span>" : "n/a") +
        stat("If assigned", money(oo.assigned_proceeds) + " for " + (oo.shares_at_risk || n * oo.multiplier) + " sh");
      note = "Short option: its market value is a liability (negative). The day gain is from your side of the trade. <a href=\"#overview\">Covered call details</a>";
    } else {
      note = "On the watchlist (not held). <a href=\"#edit/watchlist_remove/" + encodeURIComponent(r.sym) + "\">Remove from watchlist</a>";
    }
    $("d-pos-h").hidden = !ph;
    $("d-pos").innerHTML = ph;
    $("d-pos-note").innerHTML = note;
    // chart
    var c = chartFor(r.id);
    renderRanges("d-ranges", ui.range, c);
    if (anim === "draw") $("d-chart")._line = null;
    drawDetailChart(r, anim);
    if (!c || Date.now() - (ui.charts[r.id] || {}).at > REFRESH_MS - 2000) {
      var had = !!c;
      loadChart(r.id, r).then(function () { if (ui.sel === r.id) { renderRanges("d-ranges", ui.range, chartFor(r.id)); drawDetailChart(r, had ? "morph" : "draw"); } });
    }
  }
  function drawDetailChart(r, anim) {
    var c = chartFor(r.id), el = $("d-chart"), ro = $("d-readout"), noteEl = $("d-chart-note");
    if (!c) {
      var st = ui.charts[r.id] || {};
      el._sig = null; el._line = null;
      if (CAN_FETCH_EXTRA && !st.failed && chartUrl(r.id, r)) chartSkeleton(el);
      else el.innerHTML = '<p class="note chart-empty" style="min-height:' + chartH(el) + 'px">' + (!CAN_FETCH_EXTRA ? "Charts aren't included in the offline snapshot." : "No chart available for " + esc(r.sym) + " yet.") + "</p>";
      ro.innerHTML = "&nbsp;"; noteEl.textContent = "";
      return;
    }
    var R = c.ranges || {}, key = R[ui.range] ? ui.range : (R["1D"] ? "1D" : Object.keys(R)[0]);
    priceChart(el, ro, R[key], { anim: anim, label: r.sym + " price", rangeKey: key, sign: r.sign, rangeText: RANGE_WORDS[ui.range] + (key !== ui.range ? " (" + key + " shown)" : "") });
    noteEl.textContent = c.note || "";
  }

  // ---------------------------------------------------------------- transactions
  function txLine(t) {
    var extra = [];
    if (isNum(t.cash_after) && Math.abs(t.cash_after - (t.cash_before || 0)) > 0.004) extra.push("cash " + money(t.cash_before) + " → " + money(t.cash_after));
    if (isNum(t.realized_pl)) extra.push('realized <span class="' + cls(t.realized_pl) + '">' + sMoney(t.realized_pl) + "</span>");
    if (isNum(t.fees) && t.fees) extra.push("fees " + money(t.fees));
    return '<li class="tx"><div class="tx-top"><span class="tx-desc">' + esc(t.description || t.type) + '</span><span class="tx-date">' + esc(fmtDate(t.date, { month: "short", day: "numeric", year: "numeric" })) + "</span></div>" +
      '<div class="tx-sub">' + extra.concat(t.note ? ['<span class="tx-note">' + esc(t.note) + "</span>"] : [])
        .concat(t.issue ? ['<a href="' + esc(t.issue_url || "#") + '" target="_blank" rel="noopener">issue #' + esc(t.issue) + "</a>"] : []).join(" · ") + "</div></li>";
  }
  function renderTx(force) {
    var el = $("tx-list");
    if (!CAN_FETCH_EXTRA) { el.innerHTML = '<li class="note">The transaction list isn\'t included in the offline snapshot.</li>'; return; }
    if (!force && ui.tx && Date.now() - ui.txAt < REFRESH_MS - 2000) return draw();
    fetchAny(BASE_URL + "data/transactions.json").then(function (j) { ui.tx = Array.isArray(j) ? j : (j.transactions || []); ui.txAt = Date.now(); draw(); })
      .catch(function (e) { if (!ui.tx) el.innerHTML = '<li class="note">Could not load transactions (' + esc(e.message) + ").</li>"; });
    function draw() {
      var L = (ui.tx || []).slice().sort(function (a, b) { return (b.applied_at_et || b.date || "").localeCompare(a.applied_at_et || a.date || "") || (b.issue || 0) - (a.issue || 0); });
      el.innerHTML = L.length ? L.map(txLine).join("") : '<li class="note">No transactions recorded yet. Use Edit to record a trade.</li>';
    }
  }

  // ================================================================== Edit portfolio (builds a GitHub issue)
  var REPO = (document.querySelector('meta[name="trade-repo"]') || {}).content || "AT4Engineer/pq-22e56fd9";
  var TYPE_LABEL = { buy: "Buy", sell: "Sell", sell_to_open: "Sell to open", buy_to_close: "Buy to close", option_expired: "Option expired",
    option_assigned: "Option assigned", deposit: "Deposit", withdraw: "Withdraw", dividend: "Dividend", set_cash: "Set cash",
    set_cost_basis: "Set cost basis", watchlist_add: "Watchlist add", watchlist_remove: "Watchlist remove" };
  // which inputs each type uses
  var FIELDS = {
    buy: ["symbol", "qty", "price", "fees", "date", "note"], sell: ["symbol", "qty", "price", "fees", "date", "note"],
    sell_to_open: ["symbol", "qty", "price", "fees", "option", "date", "note"],
    buy_to_close: ["openopt", "symbol", "qty", "price", "fees", "option", "date", "note"],
    option_expired: ["openopt", "symbol", "qty", "option", "date", "note"],
    option_assigned: ["openopt", "symbol", "qty", "fees", "option", "date", "note"],
    deposit: ["amount", "date", "note"], withdraw: ["amount", "date", "note"], dividend: ["symbol", "amount", "date", "note"],
    set_cash: ["amount", "date", "note"], set_cost_basis: ["symbol", "price", "date", "note"],
    watchlist_add: ["symbol"], watchlist_remove: ["symbol"]
  };
  function todayET() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  function fv(id) { return ($(id).value || "").trim(); }
  function pnum(s) { if (s === "" || s == null) return null; var x = Number(String(s).replace(/[$,\s]/g, "")); return isFinite(x) ? x : NaN; }
  function optLabel(sym, o) { return [sym, o.expiry ? fmtDate(o.expiry, { month: "short", day: "numeric", year: "numeric" }) : "", isNum(o.strike) ? "$" + o.strike : "", o.right || ""].filter(Boolean).join(" "); }
  function edType() { return $("ed-type").value; }

  function edSetup() {
    var t = edType(), f = FIELDS[t] || [];
    var nodes = document.querySelectorAll("#ed-form [data-for]");
    for (var i = 0; i < nodes.length; i++) nodes[i].hidden = f.indexOf(nodes[i].getAttribute("data-for")) < 0;
    var isOpt = /open|close|expired|assigned/.test(t);
    $("ed-qty-l").textContent = isOpt ? "Contracts" : "Shares";
    $("ed-price-l").textContent = t === "set_cost_basis" ? "Average cost per share" : isOpt ? "Price per share (premium)" : "Price per share";
    $("ed-amount-l").textContent = t === "set_cash" ? "New cash balance" : t === "dividend" ? "Dividend amount" : "Amount";
    $("ed-symbol-l").textContent = isOpt ? "Underlying symbol" : "Symbol";
    $("ed-qty").placeholder = isOpt ? "1" : "0";
    if (t === "option_expired" || t === "option_assigned") $("ed-qty").placeholder = "all";
    // open-option picker for closing types
    var d = state.data || {}, opts = d.options || [];
    if (f.indexOf("openopt") >= 0) {
      $("ed-openopt").innerHTML = opts.length ? opts.map(function (o, i) { return '<option value="' + i + '">' + esc((o.position === "short" ? "Short " : "Long ") + o.contracts + " " + o.label) + "</option>"; }).join("") + '<option value="">Other (enter below)</option>'
        : '<option value="">No open options</option>';
      edPickOpt();
    }
    edPreview();
  }
  function edPickOpt() {
    var d = state.data || {}, o = (d.options || [])[+$("ed-openopt").value];
    if ($("ed-openopt").value === "" || !o) return;
    $("ed-symbol").value = o.underlying;
    $("ed-strike").value = o.strike;
    $("ed-expiry").value = o.expiry;
    var r = document.querySelector('#ed-form input[name="right"][value="' + o.type + '"]'); if (r) r.checked = true;
    if (edType() !== "option_expired" && edType() !== "option_assigned") $("ed-qty").value = o.contracts;
    if (edType() === "option_expired") $("ed-date").value = o.expiry;
  }
  function edBuild() {
    var t = edType(), f = FIELDS[t], txn = { v: 1, type: t }, err = [];
    function need(id, name, positive, integer) {
      var raw = fv(id), x = pnum(raw);
      if (raw === "") { err.push(name + " is required."); return null; }
      if (!isNum(x)) { err.push(name + " must be a number."); return null; }
      if (positive && x <= 0) err.push(name + " must be greater than 0.");
      if (!positive && x < 0) err.push(name + " can't be negative.");
      if (integer && Math.round(x) !== x) err.push(name + " must be a whole number.");
      return x;
    }
    if (f.indexOf("symbol") >= 0) {
      var sym = fv("ed-symbol").toUpperCase();
      if (!sym && !/close|expired|assigned/.test(t) && t !== "dividend") err.push("Symbol is required.");
      else if (sym && !/^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/.test(sym)) err.push("Symbol doesn't look like a ticker.");
      if (sym) txn.symbol = sym;
    }
    var isOpt = /open|close|expired|assigned/.test(t);
    if (f.indexOf("qty") >= 0) {
      if (t === "option_expired" || t === "option_assigned") { if (fv("ed-qty")) txn.qty = need("ed-qty", "Contracts", true, true); }
      else txn.qty = need("ed-qty", isOpt ? "Contracts" : "Shares", true, isOpt);
    }
    if (f.indexOf("price") >= 0) txn.price = need("ed-price", t === "set_cost_basis" ? "Average cost" : "Price", t !== "buy_to_close" && t !== "set_cost_basis");
    if (f.indexOf("amount") >= 0) txn.amount = need("ed-amount", "Amount", t !== "set_cash");
    if (f.indexOf("fees") >= 0) { txn.fees = fv("ed-fees") ? need("ed-fees", "Fees", false) : 0; }
    if (f.indexOf("option") >= 0) {
      var right = (document.querySelector('#ed-form input[name="right"]:checked') || {}).value || "call";
      var o = { right: right };
      if (fv("ed-strike")) o.strike = need("ed-strike", "Strike", true); else if (t === "sell_to_open") err.push("Strike is required.");
      if (fv("ed-expiry")) o.expiry = fv("ed-expiry"); else if (t === "sell_to_open") err.push("Expiry is required.");
      txn.option = o;
    }
    if (f.indexOf("date") >= 0) txn.date = fv("ed-date") || todayET();
    if (f.indexOf("note") >= 0 && fv("ed-note")) txn.note = fv("ed-note");
    return { txn: txn, err: err };
  }
  function edDescribe(x) {
    var t = x.type, o = x.option || {}, q = function (n) { return isNum(n) ? String(n) : "?"; };
    switch (t) {
      case "buy": case "sell": return TYPE_LABEL[t] + " " + q(x.qty) + " " + (x.symbol || "?") + " @ " + money(x.price);
      case "sell_to_open": case "buy_to_close": return TYPE_LABEL[t] + " " + q(x.qty) + " " + optLabel(x.symbol, o) + " @ " + money(x.price);
      case "option_expired": case "option_assigned": return TYPE_LABEL[t] + ": " + optLabel(x.symbol, o);
      case "deposit": case "withdraw": return TYPE_LABEL[t] + " " + money(x.amount);
      case "dividend": return "Dividend " + money(x.amount) + (x.symbol ? " from " + x.symbol : "");
      case "set_cash": return "Set cash to " + money(x.amount);
      case "set_cost_basis": return "Set cost basis " + (x.symbol || "?") + " = " + money(x.price);
      default: return TYPE_LABEL[t] + " " + (x.symbol || "?");
    }
  }
  function edCashAfter(x, cash) {
    var mult = 100, f = isNum(x.fees) ? x.fees : 0, o = x.option || {};
    switch (x.type) {
      case "buy": return cash - x.qty * x.price - f;
      case "sell": return cash + x.qty * x.price - f;
      case "sell_to_open": return cash + x.qty * x.price * mult - f;
      case "buy_to_close": return cash - x.qty * x.price * mult - f;
      case "option_expired": return cash;
      case "option_assigned": {
        var d = state.data || {}, held = (d.options || []).filter(function (h) { return h.underlying === x.symbol && (!o.strike || h.strike === o.strike); })[0];
        var n = isNum(x.qty) ? x.qty : held ? held.contracts : 1, k = isNum(o.strike) ? o.strike : held ? held.strike : null;
        if (!isNum(k)) return null;
        return o.right === "put" ? cash - k * mult * n - f : cash + k * mult * n - f;
      }
      case "deposit": case "dividend": return cash + x.amount;
      case "withdraw": return cash - x.amount;
      case "set_cash": return x.amount;
      default: return cash;
    }
  }
  function edPreview() {
    var b = edBuild(), x = b.txn, el = $("ed-preview");
    var cash = ((state.data || {}).account || {}).cash;
    if (b.err.length) { el.innerHTML = '<span class="subtle">' + esc(edDescribe(x)) + "</span>"; return; }
    var after = isNum(cash) ? edCashAfter(x, cash) : null;
    el.innerHTML = "<strong>" + esc(edDescribe(x)) + "</strong>" +
      (isNum(after) && Math.abs(after - cash) > 0.004 ? '<div class="subtle">Cash ' + money(cash) + " → " + money(after) + " (estimate; GitHub checks it)</div>" : "");
  }
  function edIssueUrl(x) {
    var title = "trade: " + edDescribe(x);
    var body = "Tap **Submit new issue** (or **Create**) to apply this to the portfolio. A GitHub Action checks it, updates `data/holdings.json`, " +
      "comments the before/after here and closes the issue. Anything wrong is reported here and nothing changes.\n\n```json\n" + JSON.stringify(x, null, 2) + "\n```\n";
    return "https://github.com/" + REPO + "/issues/new?labels=trade&title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body);
  }
  function edSubmit(ev) {
    ev.preventDefault();
    var b = edBuild(), box = $("ed-error");
    if (b.err.length) { box.hidden = false; box.innerHTML = b.err.map(esc).join("<br>"); return; }
    box.hidden = true;
    var url = edIssueUrl(b.txn);
    $("ed-link").href = url;
    $("ed-json").textContent = JSON.stringify(b.txn, null, 2);
    $("ed-done").hidden = false;
    var w = window.open(url, "_blank", "noopener");
    if (!w) { /* popup blocked or standalone app: the link above still works */ }
    $("ed-done").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function edPrefill(type, sym) {
    if (type && FIELDS[type]) $("ed-type").value = type;
    if (sym) $("ed-symbol").value = sym;
    edSetup();
  }
  function renderEditSide(d) {
    var syms = {};
    (d.positions || []).forEach(function (p) { syms[p.symbol] = 1; });
    (d.watchlist || []).forEach(function (s) { syms[s] = 1; });
    $("ed-symbols").innerHTML = Object.keys(syms).map(function (s) { return '<option value="' + esc(s) + '">'; }).join("");
    var W = d.watchlist || [];
    $("wl-chips").innerHTML = (W.length ? W.map(function (s) {
      return '<li><span>' + esc(s) + '</span><a href="#edit/watchlist_remove/' + encodeURIComponent(s) + '" aria-label="Remove ' + esc(s) + ' from watchlist">Remove</a></li>';
    }).join("") : '<li class="note">Empty</li>') + '<li class="chip-add"><a href="#edit/watchlist_add">+ Add symbol</a></li>';
    if (!$("ed-date").value) $("ed-date").value = todayET();
    if (ui.view === "edit") edPreview();
  }
  function edInit() {
    $("ed-type").addEventListener("change", edSetup);
    $("ed-openopt").addEventListener("change", function () { edPickOpt(); edPreview(); });
    $("ed-form").addEventListener("input", edPreview);
    $("ed-form").addEventListener("change", edPreview);
    $("ed-form").addEventListener("submit", edSubmit);
    $("ed-form").addEventListener("reset", function () { setTimeout(function () { $("ed-date").value = todayET(); $("ed-done").hidden = true; $("ed-error").hidden = true; edSetup(); }, 0); });
    $("ed-symbol").addEventListener("blur", function () { this.value = this.value.trim().toUpperCase(); });
    $("ed-date").value = todayET();
    edSetup();
  }

  // ================================================================== views / router
  var TAB_ORDER = ["stocks", "overview", "transactions", "edit"];
  var VIEW_TITLES = { stocks: "Stocks", overview: "Overview", transactions: "Transactions", edit: "Edit portfolio" };
  function route() {
    var h = decodeURIComponent((location.hash || "").replace(/^#/, "")), parts = h.split("/");
    var v = parts[0];
    if (["stocks", "overview", "transactions", "edit"].indexOf(v) < 0) v = window.matchMedia("(max-width: 700px)").matches ? "stocks" : "overview";
    var changed = ui.view !== v, prevView = ui.view;
    ui.view = v;
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute("data-view") !== v;
    $("view-title").textContent = $("nav-title").textContent = VIEW_TITLES[v];
    if (changed && prevView && motion()) {
      var ve = document.querySelector('.view[data-view="' + v + '"]');
      ve.style.setProperty("--vx", (TAB_ORDER.indexOf(v) > TAB_ORDER.indexOf(prevView) ? 18 : -18) + "px");
      ve.classList.remove("view-in"); void ve.offsetWidth; ve.classList.add("view-in");
    }
    var tabs = document.querySelectorAll(".tabs a");
    for (var k = 0; k < tabs.length; k++) {
      var on = tabs[k].getAttribute("data-tab") === v;
      tabs[k].classList.toggle("on", on);
      if (on) tabs[k].setAttribute("aria-current", "page"); else tabs[k].removeAttribute("aria-current");
    }
    if (v !== "stocks" || !parts[1]) {
      if (ui.sel && !(v === "stocks" && wide())) closeDetail(true);
    }
    var d = state.data;
    if (v === "stocks" && d) {
      if (parts[1]) { ui.sel = parts[1]; }
      renderStocks(d);
      if (ui.sel) { renderDetail(d); markSelected(); }
    } else if (v === "overview" && d && changed) {
      renderChart(d, true);
    } else if (v === "transactions") {
      renderTx(false);
    } else if (v === "edit") {
      if (parts[1] === "watchlist") edPrefill("watchlist_add", "");
      else if (parts[1] && FIELDS[parts[1]]) edPrefill(parts[1], parts[2] || "");
      if (d) renderEditSide(d);
    }
    if (changed) window.scrollTo(0, 0);
  }
  function uiInit() {
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", function () { if (!/^#stocks\//.test(location.hash) && ui.sel && !wide()) closeDetail(true); });
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      var pill = t.closest && t.closest("[data-pill]");
      if (pill) {
        ev.stopPropagation();
        ui.pill = PILL_MODES[(PILL_MODES.indexOf(ui.pill) + 1) % PILL_MODES.length]; lsSet("pq-pill", ui.pill);
        if (state.data) { var y = window.scrollY; ui.pillSwap = true; renderStocks(state.data); ui.pillSwap = false; window.scrollTo(0, y); }
        return;
      }
      var row = t.closest && t.closest(".srow");
      if (row) { if (row.getAttribute("data-id")) openDetail(row.getAttribute("data-id")); return; }
      var rb = t.closest && t.closest("[data-range]");
      if (rb && !rb.disabled) {
        var grp = rb.parentNode.id, k = rb.getAttribute("data-range");
        if (grp === "ac-ranges") { ui.acRange = k; lsSet("pq-ac-range", k); renderRanges("ac-ranges", k, chartFor("ACCOUNT")); drawAccount("morph"); }
        else if (grp === "d-ranges") { ui.range = k; lsSet("pq-range", k); var r = state.data && findRow(state.data, ui.sel); renderRanges("d-ranges", k, r && chartFor(r.id)); if (r) drawDetailChart(r, "morph"); }
      }
    });
    document.addEventListener("keydown", function (ev) {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList && ev.target.classList.contains("srow")) { ev.preventDefault(); openDetail(ev.target.getAttribute("data-id")); }
      if (ev.key === "Escape" && ui.sel && !wide()) closeDetail();
    });
    $("d-close").addEventListener("click", function () { closeDetail(); });
    sheetSwipeInit();
    edInit();
    route();
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    ptrInit();
  }
  // Large title fades into the compact bar as the page scrolls (--nt: 0..1).
  var scQueued = false;
  function onScroll() {
    if (scQueued) return;
    scQueued = true;
    requestAnimationFrame(function () {
      scQueued = false;
      var y = window.scrollY || 0, t = Math.min(1, Math.max(0, (y - 16) / 28));
      document.documentElement.style.setProperty("--nt", t.toFixed(3));
      document.body.classList.toggle("scrolled", y > 4);
    });
  }
  // Pull to refresh (touch screens): pull down at the top of the page to re-fetch the data now.
  function ptrInit() {
    var el = $("ptr"), st = null, busy = false, TH = 64;
    function set(y, p, o) { el.style.setProperty("--ptr-y", y.toFixed(1) + "px"); el.style.setProperty("--ptr-p", p.toFixed(3)); el.style.opacity = o; }
    document.addEventListener("touchstart", function (e) {
      st = null;
      if (busy || e.touches.length !== 1 || (window.scrollY || 0) > 0 || document.body.classList.contains("sheet-open")) return;
      if (e.target.closest && e.target.closest(".pchart, .detail, input, select, textarea, .tabs, .ranges")) return;
      st = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, dy: 0, on: false };
    }, { passive: true });
    document.addEventListener("touchmove", function (e) {
      if (!st) return;
      var dy = e.touches[0].clientY - st.y0, dx = Math.abs(e.touches[0].clientX - st.x0);
      if (!st.on) {
        if (dy > 8 && dy > dx && (window.scrollY || 0) <= 0) { st.on = true; el.classList.remove("settle"); el.classList.add("pulling"); }
        else if (dy < -4 || dx > 12) { st = null; return; }
        else return;
      }
      if (e.cancelable) e.preventDefault();
      st.dy = dy;
      var pull = Math.min(120, dy * 0.5);
      set(pull - 44, Math.min(1, pull / TH), Math.min(1, pull / 28));
    }, { passive: false });
    function end() {
      if (!st) return;
      var s = st; st = null;
      if (!s.on) return;
      var pull = Math.min(120, s.dy * 0.5);
      el.classList.remove("pulling"); el.classList.add("settle");
      if (pull >= TH) {
        busy = true; el.classList.add("loading"); set(24, 1, 1);
        var t0 = Date.now();
        var fin = function () {
          setTimeout(function () { el.classList.remove("loading"); set(-44, 0, 0); busy = false; }, Math.max(0, 650 - (Date.now() - t0)));
        };
        doRefresh().then(fin, fin);
      } else set(-44, 0, 0);
    }
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
  }
  // periodic extras: charts for what's on screen, transactions list
  function refreshExtras() {
    if (!CAN_FETCH_EXTRA || document.hidden) return Promise.resolve();
    var jobs = [];
    if (ui.view === "stocks") {
      jobs.push(loadChart("ACCOUNT", null, true).then(function (j) { if (j && ui.view === "stocks") { renderRanges("ac-ranges", ui.acRange, j); drawAccount("morph"); } }));
      if (ui.sel && state.data) {
        var r = findRow(state.data, ui.sel);
        if (r) jobs.push(loadChart(r.id, r, true).then(function () { if (ui.sel === r.id) { renderRanges("d-ranges", ui.range, chartFor(r.id)); drawDetailChart(r, "morph"); } }));
      }
    } else if (ui.view === "transactions") renderTx(true);
    return Promise.all(jobs);
  }

  // ------------------------------------------------------------------ main render / refresh
  function priceMap(d) {
    var m = {}, r = stockRows(d);
    r.held.concat(r.watch).forEach(function (x) { if (isNum(x.price)) m[x.id] = x.price; });
    return m;
  }
  function render(d) {
    state.data = d;
    ui.rowFrom = ui.lastPrices; ui.animFrom = ui.lastTotal;
    try {
      renderHeader(d); renderSummary(d); renderPositions(d); renderOption(d);
      renderChart(d, ui.view === "overview" && !ui.ovDrawn); if (ui.view === "overview") ui.ovDrawn = true;
      renderPaper(d);
      renderStocks(d); renderEditSide(d);
      ui.lastPrices = priceMap(d); ui.lastTotal = (d.account || {}).total;
      $("app").setAttribute("aria-busy", "false");
      var eb = $("render-error"); if (eb) eb.remove();
    } catch (e) {
      if (window.console) console.warn(e);
      if (!$("render-error")) $("app").insertAdjacentHTML("afterbegin", '<div class="card error-box" id="render-error">Could not render dashboard data: ' + esc(e.message) + "</div>");
    }
    ui.rowFrom = null; ui.animFrom = null;
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
  function refresh(force) {
    state.lastCheck = new Date();
    state.nextAt = Date.now() + REFRESH_MS;
    if (!DATA_URL) return Promise.resolve();
    return fetchJSON(DATA_URL).then(function (j) {
      state.fetchError = false;
      if (STANDALONE) {
        if (isNewer(j, state.data)) { state.source = "remote"; render(j); }
      } else if (force || !state.data || j.generated_at_iso !== state.data.generated_at_iso) {
        render(j);
      }
      tickStatus();
      return refreshExtras();
    }).catch(function (e) {
      state.fetchError = true;
      if (!state.data && !STANDALONE) {
        $("app").innerHTML = '<div class="card error-box">Could not load data/portfolio.json (' + esc(e.message) +
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

  // Manual refresh (pull to refresh): data, charts on screen and the transaction list.
  function doRefresh() { return refresh(true); }
  window.PQ = { refresh: doRefresh };

  var rsT = null, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () {
      if (state.data && window.innerWidth !== lastW) {
        lastW = window.innerWidth; renderChart(state.data);
        renderRanges("ac-ranges", ui.acRange, chartFor("ACCOUNT"));
        if (ui.sel) { var rr = findRow(state.data, ui.sel); renderRanges("d-ranges", ui.range, rr && chartFor(rr.id)); }
        if (ui.view === "stocks") { drawAccount(); var r = ui.sel && findRow(state.data, ui.sel); if (r) drawDetailChart(r); if (wide()) document.body.classList.remove("sheet-open"); else if (ui.sel) document.body.classList.add("sheet-open"); }
      }
    }, 200);
  });
  uiInit();
  if (STANDALONE) { state.source = "embedded"; render(EMBEDDED); }
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tickStatus, 1000); tickStatus();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.nextAt && Date.now() > state.nextAt - REFRESH_MS + 15000) refresh();
  });
})();
