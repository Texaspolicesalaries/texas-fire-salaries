'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Agg = require('./aggregate.js');

const NOW = Date.UTC(2026, 6, 1);
const iso = (mAgo) => new Date(NOW - mAgo * 30.437 * 86400000).toISOString();

// A department with a single baseline import report (like the DFW seed).
function deptFixture() {
  return {
    slug: 'test-fd', name: 'Test Fire Department', city: 'Test', county: 'Testarrant', region: 'north-texas',
    scheduleType: '24/48', flags: { paramedicIncentive: false },
    salary: {
      effectiveDate: '2025-10-01', includesScheduledOvertime: false, sourceType: 'official-pay-plan',
      sourceUrl: 'https://example.com/plan.pdf', classification: 'Firefighter',
      steps: [
        { stepName: 'Entry', minimumMonths: 0, maximumMonths: 12, baseAnnualSalary: 60000 },
        { stepName: '1 year', minimumMonths: 12, maximumMonths: 24, baseAnnualSalary: 65000 },
        { stepName: 'Top', minimumMonths: 24, maximumMonths: null, baseAnnualSalary: 72000 }
      ],
      reports: [{ contributorId: 'dfw-fire-import', submittedAt: '2025-10-01', entry: 60000, top: 72000, hasSource: true }]
    }
  };
}

test('submissionToReport normalizes a Firestore submission', () => {
  const r = Agg.submissionToReport({
    proposedValues: { entry: '$61,000', top: 73000 }, contributorId: 'u1',
    submittedAt: '2026-06-01', sourceUrl: 'https://x/y.pdf', contributorType: 'community'
  });
  assert.strictEqual(r.value, 61000);
  assert.strictEqual(r.top, 73000);
  assert.strictEqual(r.hasSource, true);
  assert.strictEqual(r.departmentMaintained, false);
});

test('submissionToReport pulls entry from amount for entry-type salaries', () => {
  const r = Agg.submissionToReport({ proposedValues: { amount: 62000, salaryType: 'ff-emt-entry' }, contributorId: 'u2', submittedAt: NOW });
  assert.strictEqual(r.value, 62000);
});

test('submissionToReport returns null without an entry figure', () => {
  assert.strictEqual(Agg.submissionToReport({ proposedValues: { schedule: '24/48' } }), null);
});

test('applyOverlay appends community reports without mutating the baseline', () => {
  const dept = deptFixture();
  const before = dept.salary.reports.length;
  const extra = [{ contributorId: 'u1', submittedAt: NOW, entry: 61000, value: 61000 }];
  const merged = Agg.applyOverlay(dept, extra);
  assert.strictEqual(merged.salary.reports.length, before + 1);
  assert.strictEqual(dept.salary.reports.length, before); // original untouched
});

test('community submissions strengthen consensus (reported -> strong)', () => {
  const dept = deptFixture();
  // Baseline = 1 import report -> "reported". Add 2 recent matching contributors.
  const base = Agg.summarize(dept, [], NOW);
  assert.strictEqual(base.confidence, 'reported');

  const extra = [
    { contributorId: 'u1', submittedAt: iso(1), entry: 60000, value: 60000 },
    { contributorId: 'u2', submittedAt: iso(2), entry: 60200, value: 60200 }
  ];
  const strong = Agg.summarize(dept, extra, NOW);
  assert.strictEqual(strong.confidence, 'strong');
  assert.ok(strong.contributors >= 3);
  assert.strictEqual(strong.communityReports, 2);
});

test('a conflicting recent submission surfaces as conflict', () => {
  const dept = deptFixture();
  const extra = [{ contributorId: 'u9', submittedAt: iso(1), entry: 85000, value: 85000 }];
  const s = Agg.summarize(dept, extra, NOW);
  assert.strictEqual(s.hasConflict, true);
  assert.strictEqual(s.confidence, 'conflicting');
});

test('summarize output is compact and serializable', () => {
  const s = Agg.summarize(deptFixture(), [], NOW);
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'communityReports', 'confidence', 'contributors', 'effectiveHourlyEntry', 'entry',
    'entryMedic', 'freshness', 'hasConflict', 'hasSalary', 'lastUpdated', 'slug', 'topBase',
    'updatedAt', 'yearsToTop'
  ].sort());
  assert.strictEqual(JSON.parse(JSON.stringify(s)).slug, 'test-fd');
});
