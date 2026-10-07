/* Projection math for the Projections tab (pure functions, no DOM). Works in the browser
 * (window.PQProj) and in Node (module.exports) so tests/projection.test.js can check it.
 *
 * Ramsey Solutions model (matches their Compound Interest / Investment Calculator JS and the
 * Jack-and-Blake education article):
 *   - Monthly compounding with nominal monthly rate = annual / 12  (not (1+r)^(1/12)-1)
 *   - Ordinary annuity: contributions at the END of each month
 *   - Combined FV = PV*(1+i)^n + PMT*((1+i)^n - 1)/i   where i = annual/12, n = months
 * Their site does not deflate for inflation; "today's dollars" here is an optional extra.
 * Sources: ramseysolutions.com/retirement/compound-interest-calculator (calculator JS);
 * ramseyeducation.help…/Jack-and-Blake-the-Math-Behind-the-Graph (11% example → $36,635).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PQProj = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Presets: 8% cautious, 10% mid history, 12% Ramsey teaching default (stock-market 10–12% range).
  var PRESETS = { conservative: 0.08, base: 0.10, optimistic: 0.12 };
  var DEFAULT_PRESET = "optimistic"; // 12% — Ramsey's common teaching rate
  var INFLATION = 0.03; // optional "today's dollars" only; Ramsey's calculator leaves inflation out

  // Ramsey: divide the annual rate by compounding periods per year (monthly → /12).
  function monthlyRate(annual) { return (annual || 0) / 12; }

  // Closed form (no yearly increase, nominal): P(1+i)^n + C*((1+i)^n - 1)/i
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
      // End-of-month contribution (ordinary annuity / Ramsey contributionTimingBefore: false)
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

  return {
    PRESETS: PRESETS, DEFAULT_PRESET: DEFAULT_PRESET, INFLATION: INFLATION,
    monthlyRate: monthlyRate, fvClosed: fvClosed, project: project,
    neededMonthly: neededMonthly, monthsBetween: monthsBetween,
    ageFromBirthdate: ageFromBirthdate, dateAtAge: dateAtAge, milestones: milestones, at: at
  };
});
