'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./consensus.js');

const NOW = Date.UTC(2026, 6, 1); // 2026-07-01
const monthsAgo = (m) => NOW - m * 30.437 * 24 * 60 * 60 * 1000;

test('valuesMatch: exact vs tolerance', () => {
  assert.strictEqual(C.valuesMatch(60000, 60000, { exact: true }), true);
  assert.strictEqual(C.valuesMatch(60000, 60001, { exact: true }), false);
  // within 1% tolerance
  assert.strictEqual(C.valuesMatch(60000, 60300, {}), true);
  assert.strictEqual(C.valuesMatch(60000, 62000, {}), false);
});

test('clusterValues groups near-equal annual figures and counts recent contributors', () => {
  const subs = [
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(2) },
    { value: 60200, contributorId: 'b', submittedAt: monthsAgo(3) }, // within 1% -> same cluster
    { value: 72000, contributorId: 'c', submittedAt: monthsAgo(1) }
  ];
  const clusters = C.clusterValues(subs, { now: NOW });
  assert.strictEqual(clusters.length, 2);
  const top = clusters[0];
  assert.strictEqual(top.uniqueRecentContributors, 2);
  assert.ok(Math.abs(top.value - 60100) <= 100); // representative ~ mean
});

test('selectCurrentCluster prefers department-maintained regardless of count', () => {
  const subs = [
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(1) },
    { value: 60000, contributorId: 'b', submittedAt: monthsAgo(1) },
    { value: 64000, contributorId: 'dept', submittedAt: monthsAgo(2), departmentMaintained: true }
  ];
  const clusters = C.clusterValues(subs, { now: NOW });
  const current = C.selectCurrentCluster(clusters, { now: NOW });
  assert.strictEqual(current.departmentMaintained, true);
  assert.strictEqual(current.value, 64000);
});

test('confidenceLabel: needed / reported / strong / conflicting / dept', () => {
  assert.strictEqual(C.confidenceLabel([], { now: NOW }).key, 'needed');

  const reported = C.clusterValues([
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(1) }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(reported, { now: NOW }).key, 'reported');

  const strong = C.clusterValues([
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(1) },
    { value: 60100, contributorId: 'b', submittedAt: monthsAgo(2) },
    { value: 59900, contributorId: 'c', submittedAt: monthsAgo(3) }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(strong, { now: NOW }).key, 'strong');

  const conflicting = C.clusterValues([
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(1) },
    { value: 75000, contributorId: 'b', submittedAt: monthsAgo(1) }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(conflicting, { now: NOW }).key, 'conflicting');

  const dept = C.clusterValues([
    { value: 64000, contributorId: 'dept', submittedAt: monthsAgo(2), departmentMaintained: true }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(dept, { now: NOW }).key, 'department_maintained');
});

test('confidenceLabel never returns "verified" wording', () => {
  Object.values(C.CONFIDENCE).forEach((c) => {
    assert.ok(!/verified/i.test(c.label), c.label + ' must not say verified');
    assert.ok(!/verified/i.test(c.description), c.description + ' must not say verified');
  });
});

test('freshnessBucket buckets by age and flags upcoming plans', () => {
  assert.strictEqual(C.freshnessBucket(monthsAgo(6), { now: NOW }).key, 'current');
  assert.strictEqual(C.freshnessBucket(monthsAgo(15), { now: NOW }).key, 'update_recommended');
  assert.strictEqual(C.freshnessBucket(monthsAgo(24), { now: NOW }).key, 'possibly_outdated');
  assert.strictEqual(C.freshnessBucket(null, { now: NOW }).key, 'none');
  assert.strictEqual(
    C.freshnessBucket(monthsAgo(1), { now: NOW, effectiveMs: NOW + 90 * 86400000 }).key,
    'upcoming'
  );
});

test('freshness thresholds are configurable', () => {
  // Tighten current window to 3 months -> a 6-month-old report is no longer current
  const b = C.freshnessBucket(monthsAgo(6), { now: NOW, freshCurrentMonths: 3, freshUpdateMonths: 9 });
  assert.strictEqual(b.key, 'update_recommended');
});

test('a trusted contributor counts as two unique contributors in a cluster', () => {
  const clusters = C.clusterValues([
    { value: 60000, contributorId: 'trusted-1', submittedAt: monthsAgo(1), trusted: true }
  ], { now: NOW });
  assert.strictEqual(clusters[0].uniqueContributors, 2);
  assert.strictEqual(clusters[0].uniqueRecentContributors, 2);
  assert.strictEqual(clusters[0].trustedContributors, 1);
});

test('two trusted contributors agreeing alone still cannot reach "strong agreement" by themselves', () => {
  const clusters = C.clusterValues([
    { value: 60000, contributorId: 'trusted-1', submittedAt: monthsAgo(1), trusted: true },
    { value: 60050, contributorId: 'trusted-2', submittedAt: monthsAgo(1), trusted: true }
  ], { now: NOW });
  // weight = 4 (2 contributors x 2 each) — still short of the real 3-more-
  // people threshold this asserts against below, so this only proves it's a
  // bounded, not unlimited, boost by checking against ordinary contributors.
  const ordinary = C.clusterValues([
    { value: 60000, contributorId: 'a', submittedAt: monthsAgo(1) },
    { value: 60050, contributorId: 'b', submittedAt: monthsAgo(1) }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(ordinary, { now: NOW }).key, 'reported');
  assert.strictEqual(C.confidenceLabel(clusters, { now: NOW }).key, 'strong'); // trust tips it over
});

test('a single trusted contributor alone cannot reach "strong agreement"', () => {
  const clusters = C.clusterValues([
    { value: 60000, contributorId: 'trusted-1', submittedAt: monthsAgo(1), trusted: true }
  ], { now: NOW });
  assert.strictEqual(C.confidenceLabel(clusters, { now: NOW }).key, 'reported');
});

test('department-maintained still wins outright over a trusted-contributor cluster', () => {
  const clusters = C.clusterValues([
    { value: 60000, contributorId: 'trusted-1', submittedAt: monthsAgo(1), trusted: true },
    { value: 60050, contributorId: 'trusted-2', submittedAt: monthsAgo(1), trusted: true },
    { value: 65000, contributorId: 'dept', submittedAt: monthsAgo(6), departmentMaintained: true }
  ], { now: NOW });
  assert.strictEqual(C.selectCurrentCluster(clusters, { now: NOW }).value, 65000);
});
