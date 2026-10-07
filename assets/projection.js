/* Projection math for the Projections tab (pure functions, no DOM). Works in the browser
 * (window.PQProj) and in Node (module.exports) so tests/projection.test.js can check it.
 *
 * Monthly compounding: the monthly rate is (1 + annual)^(1/12) - 1, so twelve months of growth equal
 * the annual rate exactly (historical returns are quoted as compound annual rates). Contributions are
 * added at the end of each month. An optional yearly increase raises the monthly contribution once
 * every 12 months. "Today's dollars" divides each month's values by (1 + inflation)^(months / 12).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PQProj = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PRESETS = { conservative: 0.06, base: 0.08, optimistic: 0.10 };
  var INFLATION = 0.03;

  function monthlyRate(annual) { return Math.pow(1 + annual, 1 / 12) - 1; }

  // Closed form (no yearly increase, nominal): P(1+m)^n + C((1+m)^n - 1)/m
  function fvClosed(start, monthly, annual, months) {
    var m = monthlyRate(annual), g = Math.pow(1 + m, months);
    return start * g + (m === 0 ? monthly * months : monthly * (g - 1) / m);
  }

  /* o: {start, monthly, months, annual, raise (yearly fraction, default 0), inflation (default 0.03),
   *     real (bool: today's dollars)}.  Returns {final, contributed, growth, values[], contrib[]} where
   * values[k] / contrib[k] are the balance / money put in after month k (k = 0..months). */
  function project(o) {
    var months = Math.max(0, Math.round(o.months || 0));
    var m = monthlyRate(o.annual || 0), raise = o.raise || 0;
    var infl = o.inflation == null ? INFLATION : o.inflation, real = !!o.real;
    var bal = +o.start || 0, put = bal, monthly = +o.monthly || 0;
    var values = [bal], contrib = [bal];
    for (var k = 1; k <= months; k++) {
      var c = monthly * Math.pow(1 + raise, Math.floor((k - 1) / 12));
      bal = bal * (1 + m) + c;
      var d = real ? Math.pow(1 + infl, k / 12) : 1;
      put += c / d;
      values.push(bal / d);
      contrib.push(put);
    }
    var final = values[values.length - 1];
    return { final: final, contributed: put, growth: final - put, values: values, contrib: contrib, months: months };
  }

  // Monthly amount (starting level, before any yearly increase) needed to reach `target` (same units).
  function neededMonthly(o, target) {
    var base = project(Object.assign({}, o, { monthly: 0 })).final;
    if (base >= target) return 0;
    var unit = project(Object.assign({}, o, { start: 0, monthly: 1 })).final;
    return unit > 0 ? (target - base) / unit : Infinity;
  }

  // Exact age in fractional years on `today` (both "YYYY-MM-DD"): whole years since birth plus the
  // fraction of the way from the last birthday to the next one.
  function ymd(s) { var p = String(s).split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function bday(y, m, d) { var t = Date.UTC(y, m, d); return new Date(t).getUTCMonth() !== m ? Date.UTC(y, m, d - 1) : t; } // Feb 29 -> Feb 28
  function ageFromBirthdate(birth, today) {
    var b = String(birth).split("-").map(Number), t = ymd(today), ty = +String(today).slice(0, 4);
    if (!b[0] || !b[1] || !b[2] || !isFinite(t)) return null;
    var years = ty - b[0], last = bday(ty, b[1] - 1, b[2]);
    if (last > t) { years -= 1; last = bday(ty - 1, b[1] - 1, b[2]); }
    var next = bday(b[0] + years + 1, b[1] - 1, b[2]);
    return years < 0 ? null : years + (t - last) / (next - last);
  }
  // Date the person reaches a (possibly fractional, e.g. 59.5) age, as "YYYY-MM-DD".
  function dateAtAge(birth, age) {
    var b = String(birth).split("-").map(Number), whole = Math.floor(age), mo = Math.round((age - whole) * 12);
    var d = new Date(Date.UTC(b[0] + whole, b[1] - 1 + mo, b[2]));
    return d.toISOString().slice(0, 10);
  }

  function monthsBetween(age, target) { return Math.max(0, Math.round((target - age) * 12)); }

  // Table ages: 25, 30, 40, 50 and the target for young starters, else every 5 years from the current age.
  function milestones(age, target) {
    var out = [];
    if (age < 25) out = [25, 30, 40, 50].filter(function (a) { return a > age && a < target; });
    else for (var a = age + 5; a < target - 1e-9; a += 5) out.push(Math.round(a * 10) / 10);
    out.push(target);
    return out;
  }

  // Value at an age (months from now rounded) from a project() result.
  function at(res, age, startAge, key) {
    var k = Math.min(res.months, Math.max(0, Math.round((age - startAge) * 12)));
    return res[key || "values"][k];
  }

  return { PRESETS: PRESETS, INFLATION: INFLATION, monthlyRate: monthlyRate, fvClosed: fvClosed, project: project,
           neededMonthly: neededMonthly, monthsBetween: monthsBetween, ageFromBirthdate: ageFromBirthdate, dateAtAge: dateAtAge, milestones: milestones, at: at };
});
