// Unit tests for assets/projection.js (run: node tests/projection.test.js; also run by test_projection.py)
"use strict";
const assert = require("assert");
const P = require("../assets/projection.js");
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 1e-6 : tol) * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
let n = 0;
const t = (name, fn) => { fn(); n++; };

t("12 monthly steps equal the annual rate", () => {
  close(Math.pow(1 + P.monthlyRate(0.08), 12), 1.08, 1e-12, "8%");
  close(Math.pow(1 + P.monthlyRate(0.10), 12), 1.10, 1e-12, "10%");
});
t("lump sum compounds at the annual rate", () => {
  close(P.project({ start: 1000, monthly: 0, months: 120, annual: 0.08 }).final, 1000 * Math.pow(1.08, 10), 1e-10, "10y");
});
t("contributions match the closed form", () => {
  const r = P.project({ start: 16848.38, monthly: 100, months: 498, annual: 0.08 });
  close(r.final, P.fvClosed(16848.38, 100, 0.08, 498), 1e-10, "FV");
  close(r.contributed, 16848.38 + 100 * 498, 1e-12, "contributed");
  close(r.growth, r.final - r.contributed, 1e-12, "growth");
});
t("zero rate just adds up", () => {
  const r = P.project({ start: 500, monthly: 50, months: 24, annual: 0 });
  close(r.final, 500 + 50 * 24, 1e-12, "sum");
  close(r.growth, 0, 1e-9, "no growth");
});
t("today's dollars divides by inflation", () => {
  const nom = P.project({ start: 10000, monthly: 0, months: 360, annual: 0.08 });
  const real = P.project({ start: 10000, monthly: 0, months: 360, annual: 0.08, real: true, inflation: 0.03 });
  close(real.final, nom.final / Math.pow(1.03, 30), 1e-10, "deflated");
  close(real.contributed, 10000, 1e-12, "starting amount is already in today's dollars");
});
t("yearly contribution increase steps every 12 months", () => {
  const r = P.project({ start: 0, monthly: 100, months: 24, annual: 0, raise: 0.10 });
  close(r.final, 12 * 100 + 12 * 110, 1e-12, "two years");
});
t("needed monthly reaches the target", () => {
  const o = { start: 16848.38, months: 498, annual: 0.08, real: true };
  const c = P.neededMonthly(o, 1e6);
  assert.ok(c > 0);
  close(P.project(Object.assign({}, o, { monthly: c })).final, 1e6, 1e-9, "round trip");
  assert.strictEqual(P.neededMonthly({ start: 2e6, months: 12, annual: 0.08 }, 1e6), 0);
});
t("milestones", () => {
  assert.deepStrictEqual(P.milestones(18, 59.5), [25, 30, 40, 50, 59.5]);
  assert.deepStrictEqual(P.milestones(33, 59.5), [38, 43, 48, 53, 58, 59.5]);
  assert.deepStrictEqual(P.milestones(57, 59.5), [59.5]);
  assert.strictEqual(P.monthsBetween(18, 59.5), 498);
});
t("at() reads the value at an age", () => {
  const r = P.project({ start: 1000, monthly: 0, months: 498, annual: 0.08 });
  close(P.at(r, 28, 18), 1000 * Math.pow(1.08, 10), 1e-10, "age 28");
  close(P.at(r, 99, 18), r.final, 1e-12, "clamped");
});
t("exact age from the birthdate", () => {
  close(P.ageFromBirthdate("2008-11-25", "2026-10-06"), 17 + 315 / 365, 1e-12, "17 and 315/365");
  assert.strictEqual(P.ageFromBirthdate("2008-11-25", "2026-11-25"), 18);
  close(P.ageFromBirthdate("2008-11-25", "2026-11-24"), 17 + 364 / 365, 1e-12, "day before");
  assert.strictEqual(P.ageFromBirthdate("2008-11-25", "2008-11-25"), 0);
  assert.strictEqual(P.ageFromBirthdate("2008-11-25", "2001-01-01"), null);
  close(P.ageFromBirthdate("2008-02-29", "2026-02-28"), 18, 1e-12, "leap-day birthday");
  assert.strictEqual(P.dateAtAge("2008-11-25", 59.5), "2068-05-25");
  assert.strictEqual(P.monthsBetween(P.ageFromBirthdate("2008-11-25", "2026-10-06"), 59.5), 500);
});
console.log(`projection.test.js: ${n} tests passed`);
