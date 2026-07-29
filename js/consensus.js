/*
 * consensus.js — Pure community-consensus + data-freshness logic.
 *
 * No DOM, no Firebase. This is the heart of the "community maintained, no owner
 * approval" model: given a set of contributor submissions for one value, decide
 * what to display, how confident we are, and how fresh it is — all deterministically.
 *
 * Rules implemented (from the product spec):
 *   - Group submissions into value CLUSTERS (exact match for structured steps,
 *     ~1% tolerance for annual figures that differ by rounding).
 *   - Choose the current displayed cluster:
 *       1. department-maintained value, if any
 *       2. otherwise the cluster with the most UNIQUE RECENT contributors
 *       3. recency as tie-breaker
 *   - Emit an understandable confidence LABEL (never a mystery number, never
 *     the word "verified" unless department-maintained).
 *   - Emit a freshness bucket from the effective / last-confirmed date.
 *
 * Dates are passed as epoch-millisecond numbers so this stays pure and testable;
 * callers convert Firestore Timestamps before calling in.
 */

'use strict';

var MS_PER_MONTH = 30.437 * 24 * 60 * 60 * 1000;

function monthsBetween(earlierMs, laterMs) {
  return (laterMs - earlierMs) / MS_PER_MONTH;
}

// Default, admin-configurable thresholds.
var DEFAULTS = {
  annualTolerance: 0.01,       // 1% relative tolerance for annual dollar figures
  recencyWindowMonths: 12,     // "recent" contributor window for consensus
  strongAgreementContributors: 3, // unique recent contributors => strong agreement
  freshCurrentMonths: 12,      // <= 12mo => current
  freshUpdateMonths: 18        // 12–18mo => update recommended; > 18 => possibly outdated
};

// ── Value matching ──────────────────────────────────────────────────────────
// exact:true  -> must be identical (used for structured pay-step values)
// exact:false -> within relative tolerance (used for annual dollar figures)
function valuesMatch(a, b, opts) {
  opts = opts || {};
  if (a == null || b == null) return false;
  if (opts.exact) return a === b;
  var tol = opts.tolerance != null ? opts.tolerance : DEFAULTS.annualTolerance;
  if (a === b) return true;
  var denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return Math.abs(a - b) / denom <= tol;
}

// ── Clustering ───────────────────────────────────────────────────────────────
// submissions: [{ value:Number, contributorId:String, submittedAt:Number(ms),
//                 hasSource:Boolean, departmentMaintained:Boolean }]
// Returns clusters sorted by (unique recent contributors desc, newest desc):
//   [{ value, submissions[], uniqueContributors, uniqueRecentContributors,
//      newest, oldest, hasSource, departmentMaintained }]
function clusterValues(submissions, opts) {
  opts = opts || {};
  var now = opts.now != null ? opts.now : Date.now();
  var recencyMonths = opts.recencyWindowMonths != null ? opts.recencyWindowMonths : DEFAULTS.recencyWindowMonths;
  var list = (submissions || []).filter(function (s) {
    return s && typeof s.value === 'number' && isFinite(s.value);
  });

  var clusters = [];
  list.forEach(function (s) {
    var target = null;
    for (var i = 0; i < clusters.length; i++) {
      if (valuesMatch(clusters[i].value, s.value, opts)) { target = clusters[i]; break; }
    }
    if (!target) {
      target = { value: s.value, submissions: [] };
      clusters.push(target);
    }
    target.submissions.push(s);
  });

  clusters.forEach(function (c) {
    var contributors = {};
    var recentContributors = {};
    var newest = -Infinity, oldest = Infinity;
    var hasSource = false, deptMaintained = false;
    var valueSum = 0, valueCount = 0;
    c.submissions.forEach(function (s) {
      if (s.contributorId != null) contributors[s.contributorId] = true;
      var t = s.submittedAt || 0;
      if (t > newest) newest = t;
      if (t < oldest) oldest = t;
      if (s.hasSource) hasSource = true;
      if (s.departmentMaintained) deptMaintained = true;
      if (t >= now - recencyMonths * MS_PER_MONTH && s.contributorId != null) {
        recentContributors[s.contributorId] = true;
      }
      valueSum += s.value; valueCount++;
    });
    c.uniqueContributors = Object.keys(contributors).length;
    c.uniqueRecentContributors = Object.keys(recentContributors).length;
    c.newest = newest === -Infinity ? null : newest;
    c.oldest = oldest === Infinity ? null : oldest;
    c.hasSource = hasSource;
    c.departmentMaintained = deptMaintained;
    // Representative value: mean of the cluster (annual figures within tolerance).
    c.value = valueCount ? Math.round((valueSum / valueCount)) : c.value;
  });

  clusters.sort(function (a, b) {
    if (b.uniqueRecentContributors !== a.uniqueRecentContributors) {
      return b.uniqueRecentContributors - a.uniqueRecentContributors;
    }
    if (b.uniqueContributors !== a.uniqueContributors) {
      return b.uniqueContributors - a.uniqueContributors;
    }
    return (b.newest || 0) - (a.newest || 0);
  });
  return clusters;
}

// ── Current-cluster selection ────────────────────────────────────────────────
function selectCurrentCluster(clusters, opts) {
  if (!clusters || clusters.length === 0) return null;
  // 1. department-maintained wins outright
  var deptCluster = clusters.filter(function (c) { return c.departmentMaintained; });
  if (deptCluster.length) {
    // most recent department-maintained value
    deptCluster.sort(function (a, b) { return (b.newest || 0) - (a.newest || 0); });
    return deptCluster[0];
  }
  // 2 & 3 already encoded in the clusterValues sort (recent contributors, then recency)
  return clusters[0];
}

// ── Confidence label ─────────────────────────────────────────────────────────
var CONFIDENCE = {
  department_maintained: { key: 'department_maintained', label: 'Department maintained', icon: '◆', tone: 'dept', description: 'The department manages this information through an official account.' },
  strong: { key: 'strong', label: 'Strong community agreement', icon: '▲', tone: 'strong', description: 'Multiple recent contributors submitted matching information.' },
  reported: { key: 'reported', label: 'Community reported', icon: '●', tone: 'reported', description: 'One or two contributors submitted this information.' },
  conflicting: { key: 'conflicting', label: 'Conflicting reports', icon: '◧', tone: 'conflicting', description: 'Recent contributors submitted materially different values.' },
  needed: { key: 'needed', label: 'Salary information needed', icon: '○', tone: 'needed', description: 'No current salary information is available.' }
};

// Decide whether two clusters materially disagree among RECENT contributors.
function hasRecentConflict(clusters, opts) {
  opts = opts || {};
  var recent = clusters.filter(function (c) { return c.uniqueRecentContributors > 0; });
  if (recent.length < 2) return false;
  // At least two distinct recent clusters that do not match one another.
  return !valuesMatch(recent[0].value, recent[1].value, opts);
}

// Returns a CONFIDENCE entry. Does NOT fold in freshness — that is a separate
// axis (see freshnessBucket); the UI shows both.
function confidenceLabel(clusters, opts) {
  opts = opts || {};
  if (!clusters || clusters.length === 0) return CONFIDENCE.needed;
  var current = selectCurrentCluster(clusters, opts);
  if (current && current.departmentMaintained) return CONFIDENCE.department_maintained;
  if (hasRecentConflict(clusters, opts)) return CONFIDENCE.conflicting;
  var strongThreshold = opts.strongAgreementContributors != null
    ? opts.strongAgreementContributors : DEFAULTS.strongAgreementContributors;
  if (current && current.uniqueRecentContributors >= strongThreshold) return CONFIDENCE.strong;
  return CONFIDENCE.reported;
}

// ── Freshness ────────────────────────────────────────────────────────────────
var FRESHNESS = {
  upcoming: { key: 'upcoming', label: 'Upcoming pay plan', icon: '◔', description: 'The effective date is in the future.' },
  current: { key: 'current', label: 'Current community report', icon: '◉', description: 'Updated or confirmed within the last 12 months.' },
  update_recommended: { key: 'update_recommended', label: 'Update recommended', icon: '◑', description: 'Last updated 12–18 months ago.' },
  possibly_outdated: { key: 'possibly_outdated', label: 'Possibly outdated', icon: '◍', description: 'Last updated more than 18 months ago.' },
  none: { key: 'none', label: 'No date on file', icon: '○', description: 'No effective or confirmation date is available.' }
};

// referenceMs: the most recent of effectiveDate / submission / confirmation (ms).
// effectiveMs (optional): the plan's effective date, to catch future plans.
function freshnessBucket(referenceMs, opts) {
  opts = opts || {};
  var now = opts.now != null ? opts.now : Date.now();
  var currentMonths = opts.freshCurrentMonths != null ? opts.freshCurrentMonths : DEFAULTS.freshCurrentMonths;
  var updateMonths = opts.freshUpdateMonths != null ? opts.freshUpdateMonths : DEFAULTS.freshUpdateMonths;
  if (opts.effectiveMs != null && opts.effectiveMs > now) return FRESHNESS.upcoming;
  if (referenceMs == null) return FRESHNESS.none;
  var age = monthsBetween(referenceMs, now);
  if (age <= currentMonths) return FRESHNESS.current;
  if (age <= updateMonths) return FRESHNESS.update_recommended;
  return FRESHNESS.possibly_outdated;
}

var FireConsensus = {
  DEFAULTS: DEFAULTS,
  CONFIDENCE: CONFIDENCE,
  FRESHNESS: FRESHNESS,
  monthsBetween: monthsBetween,
  valuesMatch: valuesMatch,
  clusterValues: clusterValues,
  selectCurrentCluster: selectCurrentCluster,
  hasRecentConflict: hasRecentConflict,
  confidenceLabel: confidenceLabel,
  freshnessBucket: freshnessBucket
};

if (typeof window !== 'undefined') window.FireConsensus = FireConsensus;
if (typeof module !== 'undefined' && module.exports) module.exports = FireConsensus;
