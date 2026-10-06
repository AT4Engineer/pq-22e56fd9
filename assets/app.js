/* Portfolio Tracker dashboard. Plain JS, no libraries, no external requests except its own data file.
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
      kv("Mark source", esc(o.mark_source || "n/a")),
      kv("Bid / ask", hasQuote ? money(o.bid) + " / " + money(o.ask) : "no live quote"),
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
  function renderChart(d) {
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
    if (H.length > 1) s += svgEl("path", { "class": "series", d: path });
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

  // ------------------------------------------------------------------ main render / refresh
  function render(d) {
    state.data = d;
    try {
      renderHeader(d); renderSummary(d); renderPositions(d); renderOption(d); renderChart(d); renderPaper(d);
      $("app").setAttribute("aria-busy", "false");
      var eb = $("render-error"); if (eb) eb.remove();
    } catch (e) {
      if (window.console) console.warn(e);
      if (!$("render-error")) $("app").insertAdjacentHTML("afterbegin", '<div class="card error-box" id="render-error">Could not render dashboard data: ' + esc(e.message) + "</div>");
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

  var rsT = null, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () { if (state.data && window.innerWidth !== lastW) { lastW = window.innerWidth; renderChart(state.data); } }, 200);
  });
  if (STANDALONE) { state.source = "embedded"; render(EMBEDDED); }
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tickStatus, 1000); tickStatus();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.nextAt && Date.now() > state.nextAt - REFRESH_MS + 15000) refresh();
  });
})();
