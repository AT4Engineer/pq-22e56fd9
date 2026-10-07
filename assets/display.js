/* Second-monitor / wall display. Dark, no navigation, no edit. Auto-refreshes every 60 s. */
(function () {
  "use strict";
  var REFRESH_MS = 60000, TZ = "America/New_York";
  var RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"];
  var RANGE_WORDS = { "1D": "today", "1W": "past week", "1M": "past month", "3M": "past 3 months", "1Y": "past year", "ALL": "all time" };
  var state = { data: null, charts: {}, range: "1D", nextAt: null, lastCheck: null, fetchError: false };

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
  function qty(x) { return isNum(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "n/a"; }
  function cls(x) { return isNum(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : ""; }
  function fmtET(iso, fallback, opts) {
    try {
      var d = new Date(iso);
      if (isNaN(d)) throw 0;
      return new Intl.DateTimeFormat("en-US", opts || { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
    } catch (e) { return fallback || "n/a"; }
  }
  function fmtDate(ymd, opts) {
    var p = String(ymd).split("-"), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    var o = opts || { month: "short", day: "numeric" }; o.timeZone = "UTC";
    return isNaN(d) ? String(ymd) : d.toLocaleDateString("en-US", o);
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
  function svgEl(tag, attrs, text) {
    var s = "<" + tag;
    for (var k in attrs) if (attrs[k] != null) s += " " + k + '="' + esc(attrs[k]) + '"';
    return s + (text != null ? ">" + text + "</" + tag + ">" : "/>");
  }
  function niceStep(range, ticks) {
    var raw = range / Math.max(1, ticks), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private */ } }
  state.range = lsGet("pq-disp-range", "1D");
  if (RANGES.indexOf(state.range) < 0) state.range = "1D";

  function tickClock() {
    $("clock").textContent = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit"
    }).format(new Date()) + " ET";
  }

  function fetchJSON(url, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 10000);
    var u = url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
    return fetch(u, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { clearTimeout(to); });
  }

  function renderHeader(d) {
    var a = d.account || {}, o = (d.options || [])[0];
    $("total").textContent = money(a.total);
    $("day").innerHTML = '<span class="' + cls(a.day_change) + '">' + sMoney(a.day_change) + " (" + sPct(a.day_change_pct) + ')</span><span class="disp-day-word">today</span>';
    var bits = [["Stocks", money(a.stocks_value)], ["Cash", money(a.cash)]];
    if (o) bits.push(["Short call", money(a.option_liability)]);
    var asof = (d.market_label || "") + (d.quotes_as_of_et ? (d.market_label ? " · " : "") + "as of " + d.quotes_as_of_et : "");
    $("sub").innerHTML = '<dl class="disp-break">' + bits.map(function (b) {
      return "<div><dt>" + esc(b[0]) + "</dt><dd>" + esc(b[1]) + "</dd></div>";
    }).join("") + "</dl>" + (asof ? '<p class="disp-asof">' + esc(asof) + "</p>" : "");
    $("updated").textContent = "Updated " + fmtET(d.generated_at_iso, d.generated_at_et);
  }

  function sparkSvg(pts, base, sign) {
    var W = 280, H = 36, P = 3;
    if (!pts || pts.length < 2) return '<svg viewBox="0 0 280 36" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="280" y1="18" y2="18" stroke="#3a3a3c" stroke-width="1" stroke-dasharray="2 3"/></svg>';
    var vals = pts.map(function (p) { return p[1]; });
    if (isNum(base)) vals.push(base);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var span = Math.max(390, pts[pts.length - 1][0]);
    function x(m) { return (m / span * W).toFixed(1); }
    function y(v) { return (P + (1 - (v - mn) / (mx - mn)) * (H - 2 * P)).toFixed(1); }
    var last = pts[pts.length - 1][1], up = !isNum(base) || (sign === -1 ? last <= base : last >= base);
    var path = pts.map(function (p, i) { return (i ? "L" : "M") + x(p[0]) + "," + y(p[1]); }).join("");
    var col = up ? "#30d158" : "#ff453a";
    return '<svg viewBox="0 0 280 36" preserveAspectRatio="none" aria-hidden="true">' +
      (isNum(base) ? '<line x1="0" x2="280" y1="' + y(base) + '" y2="' + y(base) + '" stroke="#8e8e93" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>' : "") +
      '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function holdingsRows(d) {
    var Q = d.quotes || {}, rows = [];
    (d.positions || []).forEach(function (p) {
      var q = Q[p.symbol] || {};
      rows.push({
        id: p.symbol, sym: p.symbol, name: p.name || p.symbol, sign: 1,
        price: p.price, chg: p.day_change_per_share, pct: p.day_change_pct, value: p.value,
        spark: q.spark || [], base: isNum(q.spark_base) ? q.spark_base : p.prev_close,
        meta: qty(p.shares) + " sh · " + money(p.value)
      });
    });
    (d.options || []).forEach(function (o) {
      var id = o.contract || o.key, q = Q[id] || {};
      var chg = isNum(o.prev_mark) ? o.mark - o.prev_mark : null;
      rows.push({
        id: id,
        sym: q.display || (o.underlying + " " + o.strike + (o.type === "call" ? "C" : "P")),
        name: (o.position === "short" ? "Short " : "Long ") + o.contracts + " · " +
          fmtDate(o.expiry, { month: "short", day: "numeric", year: "numeric" }) + " " + o.type,
        sign: o.position === "short" ? -1 : 1,
        price: o.mark, chg: chg, pct: isNum(chg) && o.prev_mark ? chg / o.prev_mark * 100 : null,
        value: o.liability, spark: q.spark || [], base: o.prev_mark,
        meta: "Mark " + money(o.mark) + " · " + money(o.liability) +
          (isNum(o.day_change) ? " · day " + sMoney(o.day_change) : "")
      });
    });
    return rows;
  }

  function renderHoldings(d) {
    var rows = holdingsRows(d);
    $("holdings").innerHTML = rows.map(function (r) {
      var pl = isNum(r.chg) ? r.chg * (r.sign || 1) : null;
      return '<article class="disp-card" data-id="' + esc(r.id) + '">' +
        '<div class="disp-card-top">' +
          '<div class="disp-id"><div class="sym">' + esc(r.sym) + '</div><div class="name">' + esc(r.name) + "</div></div>" +
          '<div class="disp-quote"><div class="price">' + money(r.price) + '</div><div class="chg ' + cls(pl) + '">' + sPct(r.pct) + "</div></div>" +
        "</div>" +
        '<div class="spark-wrap">' + sparkSvg(r.spark, r.base, r.sign) + "</div>" +
        '<div class="meta">' + esc(r.meta) + "</div>" +
        "</article>";
    }).join("");
  }

  function renderRanges(active, chart) {
    var box = $("ac-ranges"), R = (chart && chart.ranges) || {}, on = null;
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
    var ind = box.querySelector(".rg-ind");
    if (ind && on && box.offsetWidth) {
      ind.style.width = on.offsetWidth + "px";
      ind.style.transform = "translateX(" + on.offsetLeft + "px)";
      ind.style.opacity = "1";
    }
  }

  function priceChart(el, readout, rg, opts) {
    opts = opts || {};
    var cw = el.clientWidth;
    if (!cw) return;
    if (!rg || !rg.t || rg.t.length < 1) {
      el.innerHTML = '<p class="note chart-empty">No chart data for this range.</p>';
      readout.innerHTML = "&nbsp;";
      return;
    }
    var T = rg.t, V = rg.v, n = T.length, base = rg.base;
    var W = Math.max(280, Math.round(cw)), H = Math.max(200, Math.round(el.clientHeight || 280));
    var pl = 6, pr = W < 500 ? 58 : 72, pt = 10, pb = 26;
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
    var last = V[n - 1], up = !isNum(base) || last >= base;
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="' + (up ? "up" : "down") + '" role="img" aria-label="Account value">';
    var step = niceStep(mx - mn, 4);
    for (var g = Math.ceil(mn / step) * step; g <= mx; g += step) {
      s += svgEl("line", { "class": "gridline", x1: pl, x2: W - pr, y1: y(g).toFixed(1), y2: y(g).toFixed(1) });
      s += svgEl("text", { "class": "axis", x: W - pr + 6, y: (y(g) + 4).toFixed(1) }, esc(money0(g)));
    }
    if (isNum(base)) s += svgEl("line", { "class": "baseline", x1: pl, x2: W - pr, y1: y(base).toFixed(1), y2: y(base).toFixed(1) });
    var path = "";
    for (var i = 0; i < n; i++) if (isNum(V[i])) path += (path ? "L" : "M") + x(i).toFixed(1) + "," + y(V[i]).toFixed(1);
    if (n > 1) {
      s += svgEl("path", { "class": "area", d: path + "L" + x(n - 1).toFixed(1) + "," + (H - pb) + "L" + x(0).toFixed(1) + "," + (H - pb) + "Z" });
      s += svgEl("path", { "class": "pline", d: path });
    }
    var labels = [];
    if (timeScale) {
      [10, 12, 14].forEach(function (h) {
        var t = rg.session_open + (h * 60 - 570) * 60;
        labels.push([pl + (t - rg.session_open) / (rg.session_close - rg.session_open) * (W - pl - pr), fmtTime(t).replace(":00", "")]);
      });
    } else if (n > 1) {
      var lastKey = null, cand = [];
      for (var j = 0; j < n; j++) {
        var key = rg.interval && /m$/.test(rg.interval) ? fmtDay(T[j], { weekday: "short" }) :
          (opts.rangeKey === "1Y" ? fmtDay(T[j], { month: "short" }) : opts.rangeKey === "ALL" ? fmtDay(T[j], { year: "numeric" }) : fmtDay(T[j], { month: "short", day: "numeric" }));
        if (key !== lastKey) { cand.push([x(j), key]); lastKey = key; }
      }
      var every = Math.ceil(cand.length / (W < 500 ? 4 : 6));
      labels = cand.filter(function (_, k) { return k % every === 0; });
    }
    labels.forEach(function (L) {
      if (L[0] < W - pr - 10) s += svgEl("text", { "class": "axis", x: Math.max(L[0], pl).toFixed(1), y: H - 6, "text-anchor": L[0] < pl + 18 ? "start" : "middle" }, esc(L[1]));
    });
    s += '<line class="xhair" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" visibility="hidden"/><circle class="xdot" r="4" cx="0" cy="0" visibility="hidden"/>';
    s += svgEl("rect", { "class": "hit", x: 0, y: 0, width: W, height: H, fill: "transparent" });
    s += "</svg>";
    el.innerHTML = s;
    var first = isNum(base) ? base : V[0], ch = last - first;
    var idle = '<span class="' + cls(ch) + '">' + sMoney(ch) + " (" + sPct(first ? ch / first * 100 : null) + ")</span> " + esc(opts.rangeText || "");
    readout.innerHTML = idle;
    var svg = el.querySelector("svg"), xl = svg.querySelector(".xhair"), xd = svg.querySelector(".xdot");
    function clientXY(ev) {
      if (ev.touches && ev.touches.length) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
      if (ev.changedTouches && ev.changedTouches.length) return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
      return { x: ev.clientX, y: ev.clientY };
    }
    function svgX(ev) {
      var p = clientXY(ev), rect = svg.getBoundingClientRect();
      if (!rect.width) return x(0);
      return (p.x - rect.left) * (W / rect.width);
    }
    function onCurve(px) {
      var idx = [];
      for (var k = 0; k < n; k++) if (isNum(V[k])) idx.push(k);
      if (!idx.length) return null;
      var a0 = idx[0], aN = idx[idx.length - 1];
      if (idx.length === 1 || px <= x(a0)) return { x: x(a0), y: y(V[a0]), v: V[a0], i: a0 };
      if (px >= x(aN)) return { x: x(aN), y: y(V[aN]), v: V[aN], i: aN };
      for (var p = 0; p < idx.length - 1; p++) {
        var a = idx[p], b = idx[p + 1], x0 = x(a), x1 = x(b);
        if (px <= x1 || p === idx.length - 2) {
          var f = x1 - x0 > 0.01 ? (px - x0) / (x1 - x0) : 0;
          if (f < 0) f = 0; else if (f > 1) f = 1;
          var v = V[a] + (V[b] - V[a]) * f;
          return { x: x0 + (x1 - x0) * f, y: y(v), v: v, i: f < 0.5 ? a : b };
        }
      }
      return { x: x(aN), y: y(V[aN]), v: V[aN], i: aN };
    }
    function place(hit) {
      var X = hit.x.toFixed(1), Y = hit.y.toFixed(1);
      xl.setAttribute("x1", X); xl.setAttribute("x2", X);
      xd.setAttribute("cx", X); xd.setAttribute("cy", Y);
      xl.style.transform = "none"; xd.style.transform = "none";
      xl.setAttribute("visibility", "visible"); xd.setAttribute("visibility", "visible");
    }
    var shown = false, dragging = false;
    function show(ev) {
      if (!n) return;
      var hit = onCurve(svgX(ev));
      if (!hit) return;
      place(hit);
      shown = true;
      var k = hit.i, v = hit.v;
      var intra = rg.interval && /m$/.test(rg.interval);
      var when = intra ? fmtTime(T[k], !timeScale) + " ET" : fmtDay(T[k], { month: "short", day: "numeric", year: "numeric" });
      var c = v - first;
      readout.innerHTML = "<strong>" + esc(money(v)) + '</strong> <span class="' + cls(c) + '">' + sMoney(c) + " (" + sPct(first ? c / first * 100 : null) + ")</span> " +
        '<span class="subtle">' + esc(when) + "</span>";
    }
    function hide() { shown = false; xl.setAttribute("visibility", "hidden"); xd.setAttribute("visibility", "hidden"); readout.innerHTML = idle; }
    function setDrag(on) {
      dragging = on;
      el.classList.toggle("dragging", on);
      document.body.classList.toggle("chart-dragging", on);
    }
    svg.addEventListener("touchstart", function (ev) {
      if (!ev.touches || ev.touches.length !== 1) return;
      if (ev.cancelable) ev.preventDefault();
      setDrag(true); show(ev);
    }, { passive: false });
    svg.addEventListener("touchmove", function (ev) {
      if (!dragging) return;
      if (ev.cancelable) ev.preventDefault();
      show(ev);
    }, { passive: false });
    svg.addEventListener("touchend", function () { if (dragging) { setDrag(false); setTimeout(hide, 1500); } });
    svg.addEventListener("touchcancel", function () { if (dragging) { setDrag(false); hide(); } });
    svg.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType === "touch") return;
      setDrag(true); show(ev);
      try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    svg.addEventListener("pointermove", function (ev) {
      if (ev.pointerType === "touch") return;
      if (ev.pointerType === "mouse" && ev.buttons === 0 && !dragging) { show(ev); return; }
      if (!dragging) return;
      show(ev);
    });
    svg.addEventListener("pointerup", function (ev) {
      if (ev.pointerType === "touch") return;
      if (dragging) { setDrag(false); hide(); }
    });
    svg.addEventListener("pointercancel", function (ev) {
      if (ev.pointerType === "touch") return;
      if (dragging) setDrag(false);
      hide();
    });
    svg.addEventListener("pointerleave", function (ev) {
      if (ev.pointerType === "touch" || dragging) return;
      hide();
    });
  }

  function drawAccount() {
    var store = state.charts.ACCOUNT, c = store && store.data, el = $("ac-chart"), ro = $("ac-readout");
    if (!c) {
      el.innerHTML = '<div class="sk-chart" aria-hidden="true"></div>';
      return;
    }
    var R = c.ranges || {};
    if (!R[state.range]) state.range = R["1D"] ? "1D" : Object.keys(R)[0];
    renderRanges(state.range, c);
    priceChart(el, ro, R[state.range], { rangeKey: state.range, rangeText: RANGE_WORDS[state.range] });
    $("ac-note").textContent = "";
  }

  function loadAccount(force) {
    var c = state.charts.ACCOUNT || (state.charts.ACCOUNT = {});
    if (!force && c.data && Date.now() - c.at < REFRESH_MS - 2000) { drawAccount(); return Promise.resolve(c.data); }
    return fetchJSON("data/charts/_account.json").then(function (j) {
      state.charts.ACCOUNT = { data: j, at: Date.now() };
      drawAccount();
      return j;
    }).catch(function () {
      if (!c.data) $("ac-chart").innerHTML = '<p class="note chart-empty">Account chart not available.</p>';
    });
  }

  function render(d) {
    state.data = d;
    renderHeader(d);
    renderHoldings(d);
    renderRanges(state.range, (state.charts.ACCOUNT || {}).data);
    loadAccount(false);
  }

  function tickStatus() {
    var left = state.nextAt ? Math.max(0, Math.round((state.nextAt - Date.now()) / 1000)) : 0;
    var last = state.lastCheck ? fmtET(state.lastCheck.toISOString(), "", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "--";
    $("refresh-state").textContent = "last check " + last + (state.fetchError ? " (failed)" : "") + " · next in " + left + "s";
  }

  function refresh() {
    state.lastCheck = new Date();
    state.nextAt = Date.now() + REFRESH_MS;
    return fetchJSON("data/portfolio.json").then(function (j) {
      state.fetchError = false;
      if (!state.data || j.generated_at_iso !== state.data.generated_at_iso) render(j);
      else loadAccount(true);
      tickStatus();
    }).catch(function (e) {
      state.fetchError = true;
      if (!state.data) {
        document.body.insertAdjacentHTML("afterbegin",
          '<div class="card error-box" style="margin:12px">Could not load data (' + esc(e.message) + ").</div>");
      }
      tickStatus();
    });
  }

  document.addEventListener("click", function (ev) {
    var rb = ev.target.closest && ev.target.closest("#ac-ranges [data-range]");
    if (rb && !rb.disabled) {
      state.range = rb.getAttribute("data-range");
      lsSet("pq-disp-range", state.range);
      drawAccount();
    }
  });

  var rsT = null;
  window.addEventListener("resize", function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () { if (state.data) drawAccount(); }, 180);
  });

  tickClock();
  setInterval(tickClock, 1000);
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tickStatus, 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.nextAt && Date.now() > state.nextAt - REFRESH_MS + 15000) refresh();
  });
})();
