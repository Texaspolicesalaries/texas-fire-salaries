/*
 * aggregate.js — Pure "aggregate on write" promotion logic.
 *
 * Turns raw Firestore community submissions into (a) extra reports that merge
 * into a department's baseline and (b) a compact summary document. Reused by:
 *   - the Cloud Function that keeps department_summaries fresh on each write,
 *   - scripts/export-overlay.js that dumps consensus into the STATIC overlay,
 *   - data.js / build-site.js that merge the overlay so visitors do 0 reads.
 *
 * Pure and testable. Depends only on FireDerive (from window or require).
 */
(function () {
  'use strict';

  var Derive = (typeof window !== 'undefined' && window.FireDerive) ||
    (typeof require === 'function' && require('./derive.js'));

  function toMs(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'number') return d;
    if (d && typeof d.toMillis === 'function') return d.toMillis();
    var t = Date.parse(d);
    return isNaN(t) ? null : t;
  }
  function money(s) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    var n = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
  }

  // Normalize one Firestore `submissions` doc into the report shape derive.js uses.
  // Returns null if it carries no usable entry figure.
  function submissionToReport(sub) {
    if (!sub) return null;
    var pv = sub.proposedValues || {};
    var entry = money(pv.entry);
    if (entry == null && (pv.salaryType === 'annual-base' || String(pv.salaryType || '').indexOf('entry') !== -1)) {
      entry = money(pv.amount);
    }
    if (entry == null) return null;
    return {
      value: entry,
      entry: entry,
      top: money(pv.top),
      contributorId: sub.contributorId || null,
      submittedAt: toMs(sub.submittedAt),
      hasSource: !!(sub.sourceUrl || sub.sourceFile),
      departmentMaintained: sub.contributorType === 'department'
    };
  }

  // Return a copy of `dept` with community reports appended to its baseline
  // salary.reports, so deriveSummary / revision history / history chart all see
  // the full picture. Does not mutate the input.
  function applyOverlay(dept, overlayReports) {
    if (!overlayReports || !overlayReports.length) return dept;
    var d = Object.assign({}, dept);
    var salary = dept.salary ? Object.assign({}, dept.salary) : { steps: [], reports: [] };
    salary.reports = (salary.reports || []).concat(overlayReports);
    d.salary = salary;
    return d;
  }

  // Build the compact document stored at department_summaries/{slug}. Small and
  // serializable — safe to read 1-per-view if you ever enable a live overlay.
  function summarize(dept, overlayReports, now) {
    now = now || Date.now();
    var merged = applyOverlay(dept, overlayReports);
    var s = Derive.deriveSummary(merged, null, now);
    return {
      slug: dept.slug,
      hasSalary: !!s.hasSalary,
      entry: s.entry != null ? s.entry : null,
      topBase: s.topBase != null ? s.topBase : null,
      entryMedic: s.entryMedic != null ? s.entryMedic : null,
      yearsToTop: s.yearsToTop != null ? s.yearsToTop : null,
      effectiveHourlyEntry: s.effectiveHourlyEntry != null ? s.effectiveHourlyEntry : null,
      confidence: s.confidence ? s.confidence.key : 'needed',
      freshness: s.freshness ? s.freshness.key : 'none',
      contributors: s.contributors || 0,
      hasConflict: !!s.hasConflict,
      lastUpdated: s.lastUpdated || null,
      communityReports: (overlayReports || []).length,
      updatedAt: now
    };
  }

  var FireAggregate = { submissionToReport: submissionToReport, applyOverlay: applyOverlay, summarize: summarize, toMs: toMs, money: money };
  if (typeof window !== 'undefined') window.FireAggregate = FireAggregate;
  if (typeof module !== 'undefined' && module.exports) module.exports = FireAggregate;
})();
