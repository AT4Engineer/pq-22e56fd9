// Unit tests for assets/projection.js (run: node tests/projection.test.js; also run by test_projection.py)
// Ramsey model: monthly rate = annual/12, end-of-month contributions (ordinary annuity).
"use strict";
const assert = require("assert");
const P = require("../assets/projection.js");
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 1e-6 : tol) * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
let n = 0;
const t = (name, fn) => { fn(); n++; };

t("Ramsey monthly rate is annual/12 (not effective)", () => {
  close(P.monthlyRate(0.12), 0.01, 1e-15, "12%/12");
  close(P.monthlyRate(0.11), 0.11 / 12, 1e-15, "11%/12");
  // Twelve steps do NOT equal (1+annual) under nominal /12 — that is intentional for Ramsey.
  assert.ok(Math.abs(Math.pow(1 + P.monthlyRate(0.12), 12) - 1.12) > 1e-4, "nominal ≠ effective");
});

t("Jack and Blake: $0 start, $200/mo, 9y, 11% monthly → $36,635 (Ramsey Education)", () => {
  // Source: https://ramseyeducation.help.ramseysolutions.com/hc/en-us/articles/32702416902029-Jack-and-Blake-the-Math-Behind-the-Graph
  // "Using our Ramsey Compound Interest Calculator we put in a $0 starting balance, contributing
  //  $200 a month for 9 years, at 11% annual interest, compounding monthly, we get … $36,635."
  const r = P.project({ start: 0, monthly: 200, months: 9 * 12, annual: 0.11 });
  close(r.final, 36635.44, 1e-4, "Jack 9y FV");
  assert.strictEqual(Math.round(r.final), 36635);
  close(r.final, P.fvClosed(0, 200, 0.11, 108), 1e-10, "matches closed form");
  close(r.contributed, 21600, 1e-12, "9*12*$200");
});

t("Jack second stage: $36,635 lump for 38y at 11% ≈ $2.35M (Ramsey Education)", () => {
  const r = P.project({ start: 36635, monthly: 0, months: 38 * 12, annual: 0.11 });
  // Article: "38 years … around $2.35 million"
  close(r.final, 2349510, 5e-4, "38y growth"); // relative tol via close()
  assert.ok(r.final > 2.3e6 && r.final < 2.4e6, "in the ~2.35M band");
});

t("lump sum uses (1 + r/12)^(12t)", () => {
  const years = 10, annual = 0.12;
  const expect = 1000 * Math.pow(1 + 0.12 / 12, years * 12);
  close(P.project({ start: 1000, monthly: 0, months: years * 12, annual }).final, expect, 1e-10, "10y 12%");
});

t("contributions match the ordinary-annuity closed form", () => {
  const r = P.project({ start: 16848.38, monthly: 100, months: 500, annual: 0.12 });
  close(r.final, P.fvClosed(16848.38, 100, 0.12, 500), 1e-10, "FV");
  close(r.contributed, 16848.38 + 100 * 500, 1e-12, "contributed");
  close(r.growth, r.final - r.contributed, 1e-12, "growth");
});

t("Anderson worked example at Ramsey 12% (age≈17.86 → 59.5 = 500 mo, start $16,848.38)", () => {
  const start = 16848.38, months = 500, annual = 0.12;
  const zero = P.project({ start, monthly: 0, months, annual });
  const hundred = P.project({ start, monthly: 100, months, annual });
  // Closed-form reference (same as Ramsey FV with end-of-month deposits, no per-period rounding)
  close(zero.final, 2439186.68, 1e-4, "$0/mo");
  close(hundred.final, 3876914.41, 1e-4, "$100/mo");
});

t("zero rate just adds up", () => {
  const r = P.project({ start: 500, monthly: 50, months: 24, annual: 0 });
  close(r.final, 500 + 50 * 24, 1e-12, "sum");
  close(r.growth, 0, 1e-9, "no growth");
});

t("today's dollars divides by inflation (optional; Ramsey calc is future $)", () => {
  const nom = P.project({ start: 10000, monthly: 0, months: 360, annual: 0.12 });
  const real = P.project({ start: 10000, monthly: 0, months: 360, annual: 0.12, real: true, inflation: 0.03 });
  close(real.final, nom.final / Math.pow(1.03, 30), 1e-10, "deflated");
  close(real.contributed, 10000, 1e-12, "starting amount is already in today's dollars");
});

t("yearly contribution increase steps every 12 months", () => {
  const r = P.project({ start: 0, monthly: 100, months: 24, annual: 0, raise: 0.10 });
  close(r.final, 12 * 100 + 12 * 110, 1e-12, "two years");
});

t("needed monthly reaches the target", () => {
  const o = { start: 16848.38, months: 500, annual: 0.12, real: true };
  const c = P.neededMonthly(o, 1e6);
  assert.ok(c > 0);
  close(P.project(Object.assign({}, o, { monthly: c })).final, 1e6, 1e-9, "round trip");
  assert.strictEqual(P.neededMonthly({ start: 2e6, months: 12, annual: 0.12 }, 1e6), 0);
});

t("presets: 8 / 10 / 12 with Ramsey default 12%", () => {
  assert.strictEqual(P.PRESETS.conservative, 0.08);
  assert.strictEqual(P.PRESETS.base, 0.10);
  assert.strictEqual(P.PRESETS.optimistic, 0.12);
  assert.strictEqual(P.DEFAULT_PRESET, "optimistic");
});

t("milestones", () => {
  assert.deepStrictEqual(P.milestones(18, 59.5), [25, 30, 40, 50, 59.5]);
  assert.deepStrictEqual(P.milestones(33, 59.5), [38, 43, 48, 53, 58, 59.5]);
  assert.deepStrictEqual(P.milestones(57, 59.5), [59.5]);
  assert.strictEqual(P.monthsBetween(18, 59.5), 498);
});

t("at() reads the value at an age", () => {
  const r = P.project({ start: 1000, monthly: 0, months: 498, annual: 0.12 });
  const tenY = 1000 * Math.pow(1 + 0.12 / 12, 120);
  close(P.at(r, 28, 18), tenY, 1e-10, "age 28");
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
