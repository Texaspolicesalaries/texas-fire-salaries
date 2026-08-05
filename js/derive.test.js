'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Derive = require('./derive.js');

const NOW = Date.UTC(2026, 6, 1);
const iso = (mAgo) => new Date(NOW - mAgo * 30.437 * 86400000).toISOString();

function deptFixture() {
  return {
    slug: 'test-fd', name: 'Test Fire Department', scheduleType: '24/48', flags: {},
    salary: {
      effectiveDate: '2025-10-01', includesScheduledOvertime: false,
      steps: [
        { stepName: 'Entry', minimumMonths: 0, maximumMonths: 24, baseAnnualSalary: 60000, reportedAnnualCompensation: 66000 },
        { stepName: 'Top', minimumMonths: 24, maximumMonths: null, baseAnnualSalary: 72000, reportedAnnualCompensation: 82000 }
      ],
      reports: [{ contributorId: 'seed-import', submittedAt: '2025-10-01', entry: 60000, top: 72000, hasSource: true }]
    }
  };
}

// A department reported the common three-point way: entry, midpoint, top.
function threeStepFixture() {
  return {
    slug: 'three-step-fd', name: 'Three Step Fire Department', scheduleType: '24/48', flags: {},
    salary: {
      effectiveDate: '2025-10-01',
      steps: [
        { stepName: 'Entry', minimumMonths: 0, maximumMonths: 24, baseAnnualSalary: 60000 },
        { stepName: 'Midpoint', minimumMonths: 24, maximumMonths: 48, baseAnnualSalary: 68000, reportedAnnualCompensation: 74000 },
        { stepName: 'Top', minimumMonths: 48, maximumMonths: null, baseAnnualSalary: 78000 }
      ]
    }
  };
}

test('reportedEntry/reportedTop default to the seed step data, separate from base pay', () => {
  const s = Derive.deriveSummary(deptFixture(), [], NOW);
  assert.strictEqual(s.entry, 60000);
  assert.strictEqual(s.topBase, 72000);
  assert.strictEqual(s.reportedEntry, 66000);
  assert.strictEqual(s.reportedTop, 82000);
});

test('a community "reported total compensation" submission updates reportedTop without touching base pay', () => {
  const extra = [{ contributorId: 'u1', submittedAt: iso(1), reportedTop: 95000 }];
  const s = Derive.deriveSummary(deptFixture(), extra, NOW);
  assert.strictEqual(s.reportedTop, 95000);   // overridden by the community report
  assert.strictEqual(s.topBase, 72000);       // base pay untouched — never mixed with total comp
  assert.strictEqual(s.entry, 60000);
});

test('a community "reported total compensation" submission updates reportedEntry without touching base pay', () => {
  const extra = [{ contributorId: 'u2', submittedAt: iso(1), reportedEntry: 70000 }];
  const s = Derive.deriveSummary(deptFixture(), extra, NOW);
  assert.strictEqual(s.reportedEntry, 70000);
  assert.strictEqual(s.entry, 60000);         // base pay untouched
});

test('a reported-total-only contributor still counts toward contributors/freshness', () => {
  const withoutIt = Derive.deriveSummary(deptFixture(), [], NOW);
  const extra = [{ contributorId: 'u3', submittedAt: iso(1), reportedTop: 95000 }];
  const withIt = Derive.deriveSummary(deptFixture(), extra, NOW);
  assert.ok(withIt.contributors > withoutIt.contributors);
});

test('midpoint defaults to the seed\'s middle step in a 3-step plan; a 2-step plan has none', () => {
  const three = Derive.deriveSummary(threeStepFixture(), [], NOW);
  assert.strictEqual(three.midpoint, 68000);
  assert.strictEqual(three.reportedMidpoint, 74000);
  const two = Derive.deriveSummary(deptFixture(), [], NOW);
  assert.strictEqual(two.midpoint, null);
});

test('a community "Midpoint pay" submission overrides the seed midpoint without touching entry/top', () => {
  const extra = [{ contributorId: 'u4', submittedAt: iso(1), midpoint: 71000 }];
  const s = Derive.deriveSummary(threeStepFixture(), extra, NOW);
  assert.strictEqual(s.midpoint, 71000);
  assert.strictEqual(s.entry, 60000);
  assert.strictEqual(s.topBase, 78000);
});

test('a community midpoint submission can supply one for a plan that never had one', () => {
  const extra = [{ contributorId: 'u5', submittedAt: iso(1), midpoint: 65000 }];
  const s = Derive.deriveSummary(deptFixture(), extra, NOW); // 2-step: no seed midpoint at all
  assert.strictEqual(s.midpoint, 65000);
});

test('an admin field override wins over the seed value with no community reports at all', () => {
  const dept = deptFixture();
  dept.fieldOverrides = { entry: { value: 61234, locked: true, note: 'Verified against city payroll PDF' } };
  const s = Derive.deriveSummary(dept, [], NOW);
  assert.strictEqual(s.entry, 61234);
  assert.strictEqual(s.entryLocked, true);
  assert.strictEqual(s.entryOverrideNote, 'Verified against city payroll PDF');
  assert.ok(s.effectiveHourlyEntry > 0); // recomputed off the overridden value, not stale
});

test('an admin field override wins even against a flood of newer, matching community reports', () => {
  const dept = deptFixture();
  dept.fieldOverrides = { top: { value: 99000, locked: true } };
  const extra = [
    { contributorId: 'a', submittedAt: iso(0.1), top: 72000 },
    { contributorId: 'b', submittedAt: iso(0.1), top: 72000 },
    { contributorId: 'c', submittedAt: iso(0.1), top: 72000 }
  ];
  const s = Derive.deriveSummary(dept, extra, NOW);
  assert.strictEqual(s.topBase, 99000);
  assert.strictEqual(s.topLocked, true);
});

test('an unlocked field override still applies the value but is flagged not-locked', () => {
  const dept = deptFixture();
  dept.fieldOverrides = { midpoint: { value: 64000, locked: false } };
  const s = Derive.deriveSummary(dept, [], NOW);
  assert.strictEqual(s.midpoint, 64000);
  assert.strictEqual(s.midpointLocked, false);
});

test('a field override can supply salary data for a department that otherwise has none', () => {
  const dept = { slug: 'empty-fd', name: 'Empty FD', salary: {} };
  dept.fieldOverrides = { entry: { value: 55000, locked: true } };
  const s = Derive.deriveSummary(dept, [], NOW);
  assert.strictEqual(s.hasSalary, true);
  assert.strictEqual(s.entry, 55000);
});

test('no fieldOverrides on the department leaves ordinary consensus untouched', () => {
  const s = Derive.deriveSummary(deptFixture(), [], NOW);
  assert.strictEqual(s.entryLocked, undefined);
  assert.strictEqual(s.entry, 60000);
});

test('a "reported total compensation" midpoint submission stays separate from base midpoint', () => {
  const extra = [{ contributorId: 'u6', submittedAt: iso(1), reportedMidpoint: 90000 }];
  const s = Derive.deriveSummary(threeStepFixture(), extra, NOW);
  assert.strictEqual(s.reportedMidpoint, 90000);
  assert.strictEqual(s.midpoint, 68000); // base midpoint untouched
});

test('an undisputed figure reports a dispute count of zero', () => {
  const s = Derive.deriveSummary(deptFixture(), [], NOW);
  assert.strictEqual(s.entryDisputeCount, 0);
  assert.strictEqual(s.topDisputeCount, 0);
  assert.strictEqual(s.midpointDisputeCount, 0);
});

test('a below-threshold disputed entry value still surfaces its dispute count without being removed', () => {
  // Mirrors what scripts/export-overlay.js's applyValueDisputes annotates onto a
  // report once it has some (but not enough) flags against its entry value.
  const extra = [{ contributorId: 'u8', submittedAt: iso(1), entry: 60000, entryDisputeCount: 2 }];
  const s = Derive.deriveSummary(deptFixture(), extra, NOW);
  assert.strictEqual(s.entry, 60000); // still current — below the revert threshold
  assert.strictEqual(s.entryDisputeCount, 2);
});

test('a confirmation folded in as an ordinary report strengthens the entry cluster', () => {
  const base = Derive.deriveSummary(deptFixture(), [], NOW);
  const extra = [{ contributorId: 'u9', submittedAt: iso(1), entry: 60000 }]; // confirms the seed's own entry value
  const confirmed = Derive.deriveSummary(deptFixture(), extra, NOW);
  assert.ok(confirmed.contributors > base.contributors);
});

test('a brand-new department with no seed salary at all still shows its first community submission', () => {
  const dept = { slug: 'brand-new-fd', name: 'Brand New FD', scheduleType: '24/48', flags: {} }; // no .salary
  const before = Derive.deriveSummary(dept, [], NOW);
  assert.strictEqual(before.hasSalary, false);
  const extra = [{ contributorId: 'u7', submittedAt: iso(1), entry: 60000, midpoint: 68000, top: 78000 }];
  const after = Derive.deriveSummary(dept, extra, NOW);
  assert.strictEqual(after.hasSalary, true);
  assert.strictEqual(after.entry, 60000);
  assert.strictEqual(after.midpoint, 68000);
  assert.strictEqual(after.topBase, 78000);
});
