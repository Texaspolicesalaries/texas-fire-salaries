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
