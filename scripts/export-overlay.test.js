'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('./export-overlay.js');

function s(v) { return { stringValue: v }; }
function row(fields, submittedAt) {
  const f = Object.assign({}, fields);
  if (submittedAt) f.submittedAt = { timestampValue: submittedAt };
  return { document: { fields: f } };
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
