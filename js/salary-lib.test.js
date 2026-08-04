'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./salary-lib.js');

test('planSummary derives entry, top, years-to-top, entry-to-top %', () => {
  var steps = [
    { startMonths: 0, basePay: 60000 },
    { startMonths: 12, basePay: 66000 },
    { startMonths: 48, basePay: 78000 }
  ];
  var s = L.planSummary(steps);
  assert.strictEqual(s.entry, 60000);          // earliest step
  assert.strictEqual(s.top, 78000);            // latest step (no explicit top)
  assert.strictEqual(s.topMonths, 48);
  assert.strictEqual(s.yearsToTop, 4);         // 48/12
  assert.strictEqual(s.entryToTopPct, 30);     // (78000-60000)/60000
  assert.strictEqual(s.count, 3);
});

test('planSummary honors an explicit top step and unordered input', () => {
  var steps = [
    { startMonths: 48, basePay: 90000 },       // latest, but NOT marked top
    { startMonths: 0, basePay: 60000 },
    { startMonths: 24, basePay: 80000, isTopStep: true }  // designated top
  ];
  var s = L.planSummary(steps);
  assert.strictEqual(s.entry, 60000);
  assert.strictEqual(s.top, 80000);            // the designated top, not the latest
  assert.strictEqual(s.topMonths, 24);
  assert.strictEqual(s.yearsToTop, 2);
});

test('planSummary is null-safe with no valid steps', () => {
  assert.strictEqual(L.planSummary([]).entry, null);
  assert.strictEqual(L.planSummary([{ startMonths: 0 }]).top, null);
});

test('stepIncreases gives per-step percentage lift', () => {
  var inc = L.stepIncreases([{ startMonths: 0, basePay: 100 }, { startMonths: 12, basePay: 110 }, { startMonths: 24, basePay: 121 }]);
  assert.strictEqual(inc[0], null);
  assert.strictEqual(inc[1], 10);
  assert.strictEqual(inc[2], 10);
});

test('parseMoney handles strings, numbers, junk', () => {
  assert.strictEqual(L.parseMoney('$74,356'), 74356);
  assert.strictEqual(L.parseMoney('74356'), 74356);
  assert.strictEqual(L.parseMoney(74356), 74356);
  assert.strictEqual(L.parseMoney(''), null);
  assert.strictEqual(L.parseMoney(null), null);
  assert.strictEqual(L.parseMoney('n/a'), null);
});

test('fmtMoney formats and guards', () => {
  assert.strictEqual(L.fmtMoney(74356), '$74,356');
  assert.strictEqual(L.fmtMoney(null), '—');
  assert.strictEqual(L.fmtMoney(12.5, { cents: true }), '$12.50');
});

test('effectiveHourly divides annual by scheduled hours', () => {
  // 24/48 schedule = 2912 hrs; $75,712 base -> $26.00/hr
  assert.strictEqual(L.effectiveHourly(75712, 2912), 26);
  assert.strictEqual(L.effectiveHourly('$75,712', '2,912'), 26);
  assert.strictEqual(L.effectiveHourly(75000, 0), null);
  assert.strictEqual(L.effectiveHourly(null, 2912), null);
});

test('scheduleHours maps known cycles', () => {
  assert.strictEqual(L.scheduleHours('24/48'), 2912);
  assert.strictEqual(L.scheduleHours('40-hour'), 2080);
  assert.strictEqual(L.scheduleHours('unknown'), null);
});

test('projectEarnings sums per-year values from a step plan', () => {
  // Steps: 0-12mo=$50k, 12-24mo=$55k, 24mo+ (top)=$60k
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 },
    { minMonths: 24, maxMonths: null, value: 60000 }
  ];
  const r5 = L.projectEarnings(steps, 5);
  // Y1 50k, Y2 55k, Y3 60k, Y4 60k, Y5 60k = 285k
  assert.strictEqual(r5.total, 285000);
  assert.deepStrictEqual(r5.perYear, [50000, 55000, 60000, 60000, 60000]);
  // Open-ended top step covers years 3-5 by definition -> no assumption flagged.
  assert.strictEqual(r5.assumedCarryForward, false);
  assert.strictEqual(r5.coveredYears, 5);
});

test('projectEarnings flags carry-forward past a BOUNDED final step', () => {
  // Final step is bounded (24-36mo). Projecting to year 5 must carry it forward.
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 },
    { minMonths: 24, maxMonths: 36, value: 60000 }
  ];
  const r5 = L.projectEarnings(steps, 5);
  // Y1 50k, Y2 55k, Y3 60k, Y4 & Y5 carried from 60k = 285k
  assert.strictEqual(r5.total, 285000);
  assert.strictEqual(r5.assumedCarryForward, true);
});

test('projectEarnings without carryForward stops projecting past the plan', () => {
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 }
  ];
  const r = L.projectEarnings(steps, 4, { carryForward: false });
  // Y1 50k, Y2 55k, Y3 & Y4 past plan -> 0
  assert.strictEqual(r.total, 105000);
  assert.strictEqual(r.assumedCarryForward, false);
});

test('projectEarnings guards bad input', () => {
  assert.strictEqual(L.projectEarnings([], 5).total, null);
  assert.strictEqual(L.projectEarnings(null, 5).total, null);
  assert.strictEqual(L.projectEarnings([{ minMonths: 0, value: 50000 }], 0).total, null);
});

test('stepsForField picks the requested field and drops blanks', () => {
  const docs = [
    { minimumMonths: 0, maximumMonths: 12, baseAnnualSalary: '$50,000', reportedAnnualCompensation: '$70,000' },
    { minimumMonths: 12, maximumMonths: null, baseAnnualSalary: '', reportedAnnualCompensation: '$75,000' }
  ];
  const base = L.stepsForField(docs, 'baseAnnualSalary');
  assert.strictEqual(base.length, 1);
  assert.strictEqual(base[0].value, 50000);
  const rep = L.stepsForField(docs, 'reportedAnnualCompensation');
  assert.strictEqual(rep.length, 2);
  assert.strictEqual(rep[1].maxMonths, null);
});

test('yearsToTop reads the highest step start', () => {
  const docs = [
    { minimumMonths: 0 }, { minimumMonths: 12 }, { minimumMonths: 48 }
  ];
  assert.strictEqual(L.yearsToTop(docs), 4);
  assert.strictEqual(L.yearsToTop([]), null);
});
