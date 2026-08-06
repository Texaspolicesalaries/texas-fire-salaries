'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('./export-overlay.js');

function s(v) { return { stringValue: v }; }
function row(fields, submittedAt, docName) {
  const f = Object.assign({}, fields);
  if (submittedAt) f.submittedAt = { timestampValue: submittedAt };
  const doc = { fields: f };
  if (docName) doc.name = `projects/p/databases/(default)/documents/submissions/${docName}`;
  return { document: doc };
}

const SEED_DEPTS = [
  { slug: 'addison-fd', name: 'Addison Fire Department', city: 'Addison', county: 'Dallas', region: 'north-texas' },
  { slug: 'denton-fd', name: 'Denton Fire Department', city: 'Denton', county: 'Denton', region: 'north-texas' }
];
const ZIPS = {
  '75001': [32.96, -96.8385, 'Addison'],  // Addison — already seeded
  '76201': [33.2148, -97.1331, 'Denton'], // Denton — already seeded
  '78701': [30.2711, -97.7437, 'Austin']  // brand-new area, not in seed counties
};

test('slugify matches the seed\'s existing slug convention', () => {
  assert.strictEqual(M.slugify('Addison Fire Department'), 'addison-fire-department');
  assert.strictEqual(M.slugify('Denton County ESD No. 1'), 'denton-county-esd-no-1');
});

test('normName strips common department-name boilerplate', () => {
  assert.strictEqual(M.normName('Addison Fire Department'), 'addison');
  assert.strictEqual(M.normName('Addison FD'), 'addison');
  assert.strictEqual(M.normName('Addison Volunteer Fire Department'), 'addison volunteer');
});

test('isDuplicate matches same city + similar name, ignores different cities', () => {
  assert.strictEqual(M.isDuplicate('Addison FD', 'Addison', SEED_DEPTS), true);
  assert.strictEqual(M.isDuplicate('Addison Fire Rescue', 'Addison', SEED_DEPTS), true);
  assert.strictEqual(M.isDuplicate('Addison Fire Department', 'Plano', SEED_DEPTS), false);
  assert.strictEqual(M.isDuplicate('Brand New Fire Department', 'Frisco', SEED_DEPTS), false);
});

test('region resolver prefers a known county, falls back geographically otherwise', () => {
  const inferRegion = M.makeRegionResolver(SEED_DEPTS);
  assert.strictEqual(inferRegion('Dallas', 32.96, -96.8), 'north-texas');
  assert.strictEqual(inferRegion('Travis', 30.27, -97.74), 'central-texas'); // unknown county -> geographic fallback
  assert.strictEqual(inferRegion('', 35.2, -101.8), 'panhandle');
});

test('promoteDepartments geocodes a valid new request from its ZIP', () => {
  const rows = [row({ name: s('Brand New Fire Department'), city: s('Frisco'), county: s('Collin'), zip: s('75001'), departmentType: s('municipal') }, '2026-01-01T00:00:00Z')];
  const { departments, skippedDup, skippedNoZip } = M.promoteDepartments(rows, SEED_DEPTS, ZIPS);
  assert.strictEqual(departments.length, 1);
  assert.strictEqual(skippedDup, 0);
  assert.strictEqual(skippedNoZip, 0);
  const d = departments[0];
  assert.strictEqual(d.slug, 'brand-new-fire-department');
  assert.strictEqual(d.lat, 32.96);
  assert.strictEqual(d.lng, -96.8385);
  assert.strictEqual(d.communityAdded, true);
  assert.strictEqual(d.dataStatus, 'none');
});

test('promoteDepartments skips a request that duplicates an existing department', () => {
  const rows = [row({ name: s('Addison FD'), city: s('Addison'), zip: s('75001') })];
  const { departments, skippedDup } = M.promoteDepartments(rows, SEED_DEPTS, ZIPS);
  assert.strictEqual(departments.length, 0);
  assert.strictEqual(skippedDup, 1);
});

test('promoteDepartments skips a request with a missing or unrecognized ZIP', () => {
  const rows = [
    row({ name: s('No Zip Fire Department'), city: s('Nowhere') }),
    row({ name: s('Bad Zip Fire Department'), city: s('Nowhere'), zip: s('00000') })
  ];
  const { departments, skippedNoZip } = M.promoteDepartments(rows, SEED_DEPTS, ZIPS);
  assert.strictEqual(departments.length, 0);
  assert.strictEqual(skippedNoZip, 2);
});

test('promoteDepartments dedupes two requests for the same new department within one run, earliest wins', () => {
  const rows = [
    row({ name: s('Newtown Fire Department'), city: s('Newtown'), zip: s('75001') }, '2026-02-01T00:00:00Z'),
    row({ name: s('Newtown FD'), city: s('Newtown'), zip: s('75001') }, '2026-01-01T00:00:00Z') // earlier -> should win
  ];
  const { departments, skippedDup } = M.promoteDepartments(rows, SEED_DEPTS, ZIPS);
  assert.strictEqual(departments.length, 1);
  assert.strictEqual(skippedDup, 1);
  assert.strictEqual(departments[0].name, 'Newtown FD');
});

test('promoteDepartments resolves slug collisions with a numeric suffix', () => {
  const rows = [
    row({ name: s('Frisco Fire Department'), city: s('Frisco'), zip: s('75001') }, '2026-01-01T00:00:00Z'),
    row({ name: s('Frisco Fire Department'), city: s('Little Elm'), zip: s('76201') }, '2026-01-02T00:00:00Z')
  ];
  const { departments } = M.promoteDepartments(rows, SEED_DEPTS, ZIPS);
  assert.strictEqual(departments.length, 2);
  assert.strictEqual(departments[0].slug, 'frisco-fire-department');
  assert.strictEqual(departments[1].slug, 'frisco-fire-department-2');
});

function num(v) { return { doubleValue: v }; }
function mapVal(fields) { return { mapValue: { fields } } }

test('toReport keeps reportedEntry/reportedTop ("total comp") separate from entry/top', () => {
  const r = M.toReport({
    contributorId: s('u1'),
    proposedValues: mapVal({ reportedTop: num(95000) })
  });
  assert.strictEqual(r.reportedTop, 95000);
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.top, null);
});

test('toReport returns null when a submission carries none of entry/top/reportedEntry/reportedTop', () => {
  const r = M.toReport({ contributorId: s('u2'), proposedValues: mapVal({ schedule: s('24/48') }) });
  assert.strictEqual(r, null);
});

test('toReport still handles an ordinary base-pay submission unchanged', () => {
  const r = M.toReport({ contributorId: s('u3'), proposedValues: mapVal({ entry: num(61000) }) });
  assert.strictEqual(r.entry, 61000);
  assert.strictEqual(r.reportedEntry, null);
});

test('toReport keeps a Midpoint-career-point submission separate from entry/top', () => {
  const r = M.toReport({ contributorId: s('u4'), proposedValues: mapVal({ midpoint: num(68000) }) });
  assert.strictEqual(r.midpoint, 68000);
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.top, null);
});

test('toReport keeps a Recruit/academy pay submission separate from entry/top/midpoint', () => {
  const r = M.toReport({ contributorId: s('u7'), proposedValues: mapVal({ recruit: num(52000) }) });
  assert.strictEqual(r.recruit, 52000);
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.top, null);
  assert.strictEqual(r.midpoint, null);
});

test('toReport is not dropped for a recruit-pay-only submission (no entry/top/midpoint set)', () => {
  const r = M.toReport({ contributorId: s('u8'), proposedValues: mapVal({ recruit: num(48000) }) });
  assert.ok(r);
});

test('toReport keeps a submission that carries only supplemental pay items, not just base figures', () => {
  const supp = arrVal([mapVal({ type: s('longevity'), amount: num(500), unit: s('yr') })]);
  const r = M.toReport({ contributorId: s('u5'), proposedValues: mapVal({ supplemental: supp }) });
  assert.ok(r, 'a supplemental-only submission should not be dropped');
  assert.deepStrictEqual(r.supplemental, [{ type: 'longevity', amount: 500, unit: 'yr' }]);
});

test('toReport decodes supplemental pay items alongside an ordinary entry figure', () => {
  const supp = arrVal([mapVal({ type: s('tcfp-master'), amount: num(300), unit: s('mo') })]);
  const r = M.toReport({ contributorId: s('u6'), proposedValues: mapVal({ entry: num(61000), supplemental: supp }) });
  assert.strictEqual(r.entry, 61000);
  assert.deepStrictEqual(r.supplemental, [{ type: 'tcfp-master', amount: 300, unit: 'mo' }]);
});

test('extractCivilService keeps the most recently submitted answer per department', () => {
  const rows = [
    row({ departmentSlug: s('addison-fd'), civilService: boolVal(true) }, '2026-01-01'),
    row({ departmentSlug: s('addison-fd'), civilService: boolVal(false) }, '2026-06-01')
  ];
  assert.deepStrictEqual(M.extractCivilService(rows), { 'addison-fd': false });
});

test('extractCivilService ignores submissions that left it unanswered', () => {
  const rows = [row({ departmentSlug: s('addison-fd') }, '2026-01-01')];
  assert.deepStrictEqual(M.extractCivilService(rows), {});
});

test('extractCivilService keeps false, not just true (booleanValue: false must not be treated as absent)', () => {
  const rows = [row({ departmentSlug: s('denton-fd'), civilService: boolVal(false) }, '2026-01-01')];
  assert.deepStrictEqual(M.extractCivilService(rows), { 'denton-fd': false });
});

test('extractCivilService keeps departments separate', () => {
  const rows = [
    row({ departmentSlug: s('addison-fd'), civilService: boolVal(true) }, '2026-01-01'),
    row({ departmentSlug: s('denton-fd'), civilService: boolVal(false) }, '2026-01-01')
  ];
  assert.deepStrictEqual(M.extractCivilService(rows), { 'addison-fd': true, 'denton-fd': false });
});

function intVal(v) { return { integerValue: String(v) }; }
function boolVal(v) { return { booleanValue: v }; }
function arrVal(items) { return { arrayValue: { values: items } }; }
function stepVal(step) {
  const f = { label: s(step.label), startMonths: intVal(step.startMonths), basePay: num(step.basePay) };
  if (step.isTopStep) f.isTopStep = boolVal(true);
  return mapVal(f);
}
function planRow(slug, steps, submittedAt, extra, docName) {
  return row(Object.assign({
    mode: s('plan'), departmentSlug: s(slug),
    proposedValues: mapVal({ steps: arrVal(steps.map(stepVal)) }),
    plan: mapVal({ classification: s('Firefighter'), effectiveDate: s('2026-01-01') })
  }, extra), submittedAt, docName);
}

test('decodeValue unwraps scalars, arrays, and nested maps', () => {
  assert.strictEqual(M.decodeValue(s('hi')), 'hi');
  assert.strictEqual(M.decodeValue(intVal(12)), 12);
  assert.strictEqual(M.decodeValue(boolVal(true)), true);
  assert.strictEqual(M.decodeValue(null), null);
  assert.deepStrictEqual(M.decodeValue(arrVal([num(1), num(2)])), [1, 2]);
  assert.deepStrictEqual(M.decodeValue(mapVal({ a: s('x'), b: num(2) })), { a: 'x', b: 2 });
});

test('extractStepPlans recovers a full step table, computing maximumMonths from the next step', () => {
  const rows = [planRow('addison-fd', [
    { label: 'Entry', startMonths: 0, basePay: 60000 },
    { label: 'Step 2', startMonths: 12, basePay: 66000 },
    { label: 'Top', startMonths: 48, basePay: 78000, isTopStep: true }
  ], '2026-01-01T00:00:00Z')];
  const plans = M.extractStepPlans(rows);
  const p = plans['addison-fd'];
  assert.ok(p);
  assert.strictEqual(p.steps.length, 3);
  assert.strictEqual(p.steps[0].minimumMonths, 0);
  assert.strictEqual(p.steps[0].maximumMonths, 12);   // next step's start
  assert.strictEqual(p.steps[2].maximumMonths, null); // last step is open-ended
  assert.strictEqual(p.classification, 'Firefighter');
  assert.strictEqual(p.effectiveDate, '2026-01-01');
});

test('extractStepPlans ignores non-plan-mode submissions and empty step arrays', () => {
  const single = row({ mode: s('single'), departmentSlug: s('addison-fd'), proposedValues: mapVal({ entry: num(60000) }) });
  const emptyPlan = planRow('denton-fd', [], '2026-01-01T00:00:00Z');
  const plans = M.extractStepPlans([single, emptyPlan]);
  assert.deepStrictEqual(plans, {});
});

test('extractStepPlans keeps the most recently submitted plan per department', () => {
  const rows = [
    planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z'),
    planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 65000 }], '2026-03-01T00:00:00Z')
  ];
  const plans = M.extractStepPlans(rows);
  assert.strictEqual(plans['addison-fd'].steps[0].baseAnnualSalary, 65000);
});

test('docId reads the doc ID from the Firestore REST resource name', () => {
  assert.strictEqual(M.docId({ name: 'projects/p/databases/(default)/documents/submissions/AbC123' }), 'AbC123');
  assert.strictEqual(M.docId({}), null);
  assert.strictEqual(M.docId(null), null);
});

test('extractStepPlans keeps a lightly-flagged plan visible, marked disputed, below the threshold', () => {
  const rows = [planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z', null, 'flagged-once')];
  const counts = new Map([['flagged-once', 1]]); // 1 flag, default threshold is 3
  const plans = M.extractStepPlans(rows, counts);
  assert.ok(plans['addison-fd']); // still shown
  assert.strictEqual(plans['addison-fd'].disputed, true);
  assert.strictEqual(plans['addison-fd'].disputeCount, 1);
  assert.strictEqual(plans['addison-fd'].steps[0].baseAnnualSalary, 60000); // unchanged
});

test('extractStepPlans reverts to the next plan once flags reach the threshold', () => {
  const rows = [
    planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z', null, 'older'),
    planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 999999 }], '2026-03-01T00:00:00Z', null, 'newer-bad')
  ];
  const counts = new Map([['newer-bad', 3]]); // hits the default threshold
  const plans = M.extractStepPlans(rows, counts);
  assert.strictEqual(plans['addison-fd'].id, 'older');
  assert.strictEqual(plans['addison-fd'].steps[0].baseAnnualSalary, 60000);
  assert.strictEqual(plans['addison-fd'].disputed, false);
});

test('extractStepPlans shows no plan for a department when every submission has reverted', () => {
  const rows = [planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z', null, 'only-one')];
  const plans = M.extractStepPlans(rows, new Map([['only-one', 3]]));
  assert.strictEqual(plans['addison-fd'], undefined);
});

test('extractStepPlans is unaffected by disputes for a different department', () => {
  const rows = [planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z', null, 'x')];
  const plans = M.extractStepPlans(rows, new Map([['some-other-dept-plan-id', 5]]));
  assert.ok(plans['addison-fd']);
  assert.strictEqual(plans['addison-fd'].disputed, false);
});

test('extractStepPlans respects a custom threshold', () => {
  const rows = [planRow('addison-fd', [{ label: 'Entry', startMonths: 0, basePay: 60000 }], '2026-01-01T00:00:00Z', null, 'flagged-twice')];
  const counts = new Map([['flagged-twice', 2]]);
  assert.strictEqual(M.extractStepPlans(rows, counts, 2)['addison-fd'], undefined); // reverts at threshold 2
  assert.ok(M.extractStepPlans(rows, counts, 3)['addison-fd']); // still visible at threshold 3
});

test('confirmationToReport carries confirmed entry/midpoint/top through as an ordinary report', () => {
  const r = M.confirmationToReport({ contributorId: s('u1'), confirmedEntry: num(60000), confirmedTop: num(78000) });
  assert.strictEqual(r.entry, 60000);
  assert.strictEqual(r.top, 78000);
  assert.strictEqual(r.midpoint, null);
  assert.strictEqual(r.hasSource, false);
});

test('confirmationToReport returns null when nothing was confirmed', () => {
  assert.strictEqual(M.confirmationToReport({ contributorId: s('u2') }), null);
});

function confirmRow(slug, contributorId, createdAt, confirmedEntry) {
  return row({
    departmentSlug: s(slug), contributorId: s(contributorId),
    confirmedEntry: num(confirmedEntry == null ? 60000 : confirmedEntry),
    createdAt: { timestampValue: createdAt }
  });
}

test('dedupeConfirmations keeps only one confirmation per contributor per department', () => {
  const rows = [
    confirmRow('addison-fd', 'u1', '2026-01-01T00:00:00Z'),
    confirmRow('addison-fd', 'u1', '2026-02-01T00:00:00Z'), // same person, repeat click
    confirmRow('addison-fd', 'u2', '2026-01-15T00:00:00Z')  // different person
  ];
  const out = M.dedupeConfirmations(rows);
  assert.strictEqual(out.length, 2); // u1's repeat collapses to one
});

test('dedupeConfirmations keeps each contributor\'s most recent confirmation', () => {
  const rows = [
    confirmRow('addison-fd', 'u1', '2026-01-01T00:00:00Z', 60000),
    confirmRow('addison-fd', 'u1', '2026-03-01T00:00:00Z', 65000)
  ];
  const out = M.dedupeConfirmations(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].document.fields.confirmedEntry.doubleValue, 65000); // the later one wins
});

test('dedupeConfirmations treats the same contributor confirming different departments as separate', () => {
  const rows = [confirmRow('addison-fd', 'u1', '2026-01-01T00:00:00Z'), confirmRow('denton-fd', 'u1', '2026-01-01T00:00:00Z')];
  assert.strictEqual(M.dedupeConfirmations(rows).length, 2);
});

test('dedupeConfirmations drops malformed rows with no department or contributor', () => {
  const rows = [row({ confirmedEntry: num(60000) })];
  assert.strictEqual(M.dedupeConfirmations(rows).length, 0);
});

test('applyValueDisputes leaves a report untouched when nothing about it is disputed', () => {
  const reports = [{ contributorId: 'u1', entry: 60000, top: 78000 }];
  const out = M.applyValueDisputes(reports, 'addison-fd', new Map());
  assert.strictEqual(out[0].entry, 60000);
  assert.strictEqual(out[0].top, 78000);
  assert.strictEqual(out[0].entryDisputeCount, undefined);
});

test('applyValueDisputes annotates a below-threshold disputed value but keeps it', () => {
  const reports = [{ contributorId: 'u1', entry: 60000, top: 78000 }];
  const counts = new Map([['addison-fd|entry|60000', 2]]); // below default threshold of 3
  const out = M.applyValueDisputes(reports, 'addison-fd', counts);
  assert.strictEqual(out[0].entry, 60000); // still present
  assert.strictEqual(out[0].entryDisputeCount, 2);
  assert.strictEqual(out[0].top, 78000); // untouched — dispute only targeted entry
});

test('applyValueDisputes suppresses only the disputed field once it hits the threshold', () => {
  const reports = [{ contributorId: 'u1', entry: 60000, top: 78000 }];
  const counts = new Map([['addison-fd|entry|60000', 3]]);
  const out = M.applyValueDisputes(reports, 'addison-fd', counts);
  assert.strictEqual(out[0].entry, null);   // suppressed
  assert.strictEqual(out[0].top, 78000);    // top was never disputed — untouched
});

test('applyValueDisputes suppresses a disputed recruit-pay value the same as entry/top/midpoint', () => {
  const reports = [{ contributorId: 'u1', recruit: 52000 }];
  const counts = new Map([['addison-fd|recruit|52000', 3]]);
  const out = M.applyValueDisputes(reports, 'addison-fd', counts);
  assert.strictEqual(out[0].recruit, null);
});

test('applyValueDisputes respects a custom threshold', () => {
  const reports = [{ contributorId: 'u1', entry: 60000 }];
  const counts = new Map([['addison-fd|entry|60000', 2]]);
  assert.strictEqual(M.applyValueDisputes(reports, 'addison-fd', counts, 2)[0].entry, null);
  assert.strictEqual(M.applyValueDisputes(reports, 'addison-fd', counts, 3)[0].entry, 60000);
});

// ── computeActiveClaimants ───────────────────────────────────────────────────
const CLAIM_NOW = Date.parse('2026-08-05T00:00:00Z');
function monthsAgo(n) { return new Date(CLAIM_NOW - n * 30.437 * 24 * 3600 * 1000).toISOString().slice(0, 10); }

test('computeActiveClaimants keeps a claimant with a recent submission', () => {
  const claims = [{ userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(20), createdAt: monthsAgo(20) }];
  const subRows = [row({ contributorId: s('u1'), departmentSlug: s('addison-fd') }, monthsAgo(1) + 'T00:00:00Z')];
  const active = M.computeActiveClaimants(claims, subRows, CLAIM_NOW);
  assert.ok(active.has('u1|addison-fd'));
});

test('computeActiveClaimants expires a claimant whose last submission is past the threshold', () => {
  const claims = [{ userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(30), createdAt: monthsAgo(30) }];
  const subRows = [row({ contributorId: s('u1'), departmentSlug: s('addison-fd') }, monthsAgo(20) + 'T00:00:00Z')];
  const active = M.computeActiveClaimants(claims, subRows, CLAIM_NOW);
  assert.ok(!active.has('u1|addison-fd'));
});

test('computeActiveClaimants gives a brand-new claimant with no submission yet a full grace window from approval', () => {
  const claims = [{ userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(2), createdAt: monthsAgo(2) }];
  const active = M.computeActiveClaimants(claims, [], CLAIM_NOW);
  assert.ok(active.has('u1|addison-fd'));
});

test('computeActiveClaimants expires a claimant who never submitted once the grace window from approval passes', () => {
  const claims = [{ userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(20), createdAt: monthsAgo(20) }];
  const active = M.computeActiveClaimants(claims, [], CLAIM_NOW);
  assert.ok(!active.has('u1|addison-fd'));
});

test('computeActiveClaimants keeps departments and users separate', () => {
  const claims = [
    { userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(1), createdAt: monthsAgo(1) },
    { userId: 'u2', departmentSlug: 'denton-fd', resolvedAt: monthsAgo(30), createdAt: monthsAgo(30) }
  ];
  const active = M.computeActiveClaimants(claims, [], CLAIM_NOW);
  assert.ok(active.has('u1|addison-fd'));
  assert.ok(!active.has('u2|denton-fd'));
  assert.ok(!active.has('u1|denton-fd')); // never claimed this pair
});

test('computeActiveClaimants respects a custom threshold', () => {
  const claims = [{ userId: 'u1', departmentSlug: 'addison-fd', resolvedAt: monthsAgo(10), createdAt: monthsAgo(10) }];
  const active6mo = M.computeActiveClaimants(claims, [], CLAIM_NOW, 6);
  const active12mo = M.computeActiveClaimants(claims, [], CLAIM_NOW, 12);
  assert.ok(!active6mo.has('u1|addison-fd'));
  assert.ok(active12mo.has('u1|addison-fd'));
});

test('CLAIM_EXPIRY_MONTHS matches the "possibly outdated" freshness cutoff already used elsewhere', () => {
  assert.strictEqual(M.CLAIM_EXPIRY_MONTHS, 18);
});

test('extractDeptOverrides reads a name/coordinate correction', () => {
  const rows = [row({ departmentSlug: s('addison-fd'), name: s('Addison Fire Dept (corrected)'), lat: { doubleValue: 32.96 }, lng: { doubleValue: -96.83 } })];
  const overrides = M.extractDeptOverrides(rows);
  assert.strictEqual(overrides['addison-fd'].name, 'Addison Fire Dept (corrected)');
  assert.strictEqual(overrides['addison-fd'].lat, 32.96);
});

test('extractDeptOverrides reads a duplicate merge mark', () => {
  const rows = [row({ departmentSlug: s('addison-vfd'), mergeIntoSlug: s('addison-fd') })];
  const overrides = M.extractDeptOverrides(rows);
  assert.strictEqual(overrides['addison-vfd'].mergeIntoSlug, 'addison-fd');
});

test('extractDeptOverrides skips a row with no usable fields', () => {
  const rows = [row({ departmentSlug: s('addison-fd') })];
  assert.deepStrictEqual(M.extractDeptOverrides(rows), {});
});

test('computeMergedRedirects builds from/to pairs, dropping a self-referencing entry', () => {
  const overrides = { 'addison-vfd': { mergeIntoSlug: 'addison-fd' }, 'plain-fd': { name: 'x' }, 'loop-fd': { mergeIntoSlug: 'loop-fd' } };
  const redirects = M.computeMergedRedirects(overrides);
  assert.deepStrictEqual(redirects, [{ from: 'addison-vfd', to: 'addison-fd' }]);
});

test('extractFieldLocks reads an active lock', () => {
  const rows = [row({ departmentSlug: s('addison-fd'), field: s('entry'), value: s('76500'), note: s('Verified with city payroll') })];
  const locks = M.extractFieldLocks(rows);
  assert.deepStrictEqual(locks['addison-fd'].entry, { value: 76500, locked: true, note: 'Verified with city payroll' });
});

test('extractFieldLocks omits a lock explicitly marked inactive (unlocked)', () => {
  const rows = [row({ departmentSlug: s('addison-fd'), field: s('entry'), value: s('76500'), active: { booleanValue: false } })];
  assert.deepStrictEqual(M.extractFieldLocks(rows), {});
});

test('extractFieldLocks ignores an unrecognized field name', () => {
  const rows = [row({ departmentSlug: s('addison-fd'), field: s('recruit'), value: s('50000') })];
  assert.deepStrictEqual(M.extractFieldLocks(rows), {});
});

test('adminCorrectionToReport shapes a one-time correction as an ordinary, labeled report', () => {
  const fields = { departmentSlug: s('addison-fd'), field: s('top'), value: s('99000'), note: s('Matches the FY26 pay plan'), createdBy: s('fastford19@gmail.com') };
  const parsed = M.adminCorrectionToReport(fields);
  assert.strictEqual(parsed.slug, 'addison-fd');
  assert.strictEqual(parsed.report.top, 99000);
  assert.strictEqual(parsed.report.adminCorrection, true);
  assert.strictEqual(parsed.report.contributorId, 'admin:fastford19@gmail.com');
});

test('adminCorrectionToReport returns null with no usable value', () => {
  assert.strictEqual(M.adminCorrectionToReport({ departmentSlug: s('addison-fd'), field: s('top') }), null);
});

test('extractSuspendedContributors collects userIds into a Set', () => {
  const rows = [row({ userId: s('u1') }), row({ userId: s('u2') })];
  const set = M.extractSuspendedContributors(rows);
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('u1') && set.has('u2'));
});

function subRow(contributorId, slug, entry) {
  return row({ contributorId: s(contributorId), departmentSlug: s(slug), proposedValues: mapVal({ entry: num(entry) }) });
}

test('computeTrustedContributors trusts a contributor with enough undisputed reports across enough departments', () => {
  const rows = [
    subRow('u1', 'addison-fd', 60000),
    subRow('u1', 'allen-fd', 70000),
    subRow('u1', 'anna-fd', 65000)
  ];
  const trusted = M.computeTrustedContributors(rows, new Map());
  assert.ok(trusted.has('u1'));
});

test('computeTrustedContributors withholds trust below the report/department minimums', () => {
  const tooFewReports = M.computeTrustedContributors([subRow('u1', 'addison-fd', 60000), subRow('u1', 'allen-fd', 70000)], new Map());
  assert.ok(!tooFewReports.has('u1'));
  const oneDeptOnly = M.computeTrustedContributors([subRow('u2', 'addison-fd', 60000), subRow('u2', 'addison-fd', 61000), subRow('u2', 'addison-fd', 62000)], new Map());
  assert.ok(!oneDeptOnly.has('u2'));
});

test('computeTrustedContributors disqualifies a contributor whose value was successfully disputed', () => {
  const rows = [subRow('u1', 'addison-fd', 60000), subRow('u1', 'allen-fd', 70000), subRow('u1', 'anna-fd', 65000)];
  const disputeCounts = new Map([['addison-fd|entry|60000', M.DISPUTE_REVERT_THRESHOLD]]);
  const trusted = M.computeTrustedContributors(rows, disputeCounts);
  assert.ok(!trusted.has('u1'));
});

test('computeTrustedContributors never trusts a suspended contributor', () => {
  const rows = [subRow('u1', 'addison-fd', 60000), subRow('u1', 'allen-fd', 70000), subRow('u1', 'anna-fd', 65000)];
  const trusted = M.computeTrustedContributors(rows, new Map(), { suspendedIds: new Set(['u1']) });
  assert.ok(!trusted.has('u1'));
});

test('computeTrustedContributors respects custom thresholds', () => {
  const rows = [subRow('u1', 'addison-fd', 60000), subRow('u1', 'allen-fd', 70000)];
  const trusted = M.computeTrustedContributors(rows, new Map(), { minReports: 2, minDepartments: 2 });
  assert.ok(trusted.has('u1'));
});

