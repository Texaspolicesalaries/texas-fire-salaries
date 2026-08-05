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

  // Which displayed figure a quick-update `amount` refers to, from its salary type.
  function metricFromType(t) {
    t = String(t || '');
    if (t === 'top-ff' || t === 'top-ff-medic') return 'top';
    if (t === 'hourly-base') return 'skip';
    return 'entry';
  }

  // Normalize one Firestore `submissions` doc into the report shape derive.js uses.
  // Maps a quick-update amount to entry or top by its salary type. `midpoint`,
  // and `reportedEntry`/`reportedMidpoint`/`reportedTop` (set when a submission is
  // tagged "Reported total compensation") each stay on their own track — never
  // merged into entry/top — so a midpoint or total-comp figure can't get treated
  // as entry/top base pay in comparisons. Returns null if it carries none of
  // these six figures.
  function submissionToReport(sub) {
    if (!sub) return null;
    var pv = sub.proposedValues || {};
    var amount = money(pv.amount);
    var entry = money(pv.entry);
    var top = money(pv.top);
    var midpoint = money(pv.midpoint);
    var reportedEntry = money(pv.reportedEntry);
    var reportedTop = money(pv.reportedTop);
    var reportedMidpoint = money(pv.reportedMidpoint);
    var metric = metricFromType(pv.salaryType);
    if (entry == null && metric === 'entry') entry = amount;
    if (top == null && metric === 'top') top = amount;
    if (entry == null && top == null && midpoint == null && reportedEntry == null && reportedTop == null && reportedMidpoint == null) return null;
    return {
      value: entry != null ? entry : top,
      entry: entry,
      top: top,
      midpoint: midpoint,
      reportedEntry: reportedEntry,
      reportedTop: reportedTop,
      reportedMidpoint: reportedMidpoint,
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

  // Replaces a department's step table with a live, community-submitted full
  // step plan — the site's own philosophy is that a community submission
  // supersedes historical/starter seed data (schema.md: seed salary is labeled
  // "historical...until the community updates it"). "Most recent submission
  // wins" (selected upstream in scripts/export-overlay.js) rather than
  // clustering across competing full plans, which the numeric entry/top/midpoint
  // consensus already does independently and is unaffected by this. Does not
  // mutate the input; existing community `reports` are left untouched.
  function applyStepPlan(dept, stepPlan) {
    if (!stepPlan || !stepPlan.steps || !stepPlan.steps.length) return dept;
    var d = Object.assign({}, dept);
    var salary = dept.salary ? Object.assign({}, dept.salary) : {};
    salary.steps = stepPlan.steps;
    // Carried through so the page can offer "flag this pay-step plan" against
    // the exact submission currently showing (see js/department.js), and show a
    // disputed notice once at least one flag exists but hasn't reached the
    // revert threshold yet (scripts/export-overlay.js's extractStepPlans).
    salary.stepPlanId = stepPlan.id || null;
    salary.stepPlanDisputed = !!stepPlan.disputed;
    salary.stepPlanDisputeCount = stepPlan.disputeCount || 0;
    if (stepPlan.classification) salary.classification = stepPlan.classification;
    if (stepPlan.effectiveDate) salary.effectiveDate = stepPlan.effectiveDate;
    if (stepPlan.sourceType) salary.sourceType = stepPlan.sourceType;
    if (stepPlan.sourceUrl) salary.sourceUrl = stepPlan.sourceUrl;
    d.salary = salary;
    d.dataStatus = 'current';
    return d;
  }

  // Folds in a department-level fact (not a pay figure) a contributor
  // optionally asserted alongside their salary submission — see
  // scripts/export-overlay.js's extractCivilService. civilService lives at
  // the TOP level of the department object, matching schema.md and the field
  // js/filters.js already reads directly off `d.civilService`.
  function applyCivilService(dept, value) {
    if (value !== true && value !== false) return dept;
    var d = Object.assign({}, dept);
    d.civilService = value;
    return d;
  }

  // Supplemental pay ITEMS a contributor attaches to a submission (certification
  // tiers, education tiers, longevity — see js/submit.js's SUPP_TYPES) are the
  // real, live source for the "Has certification/education/longevity pay"
  // filter checkboxes — the flags.* booleans baked into seed data are never set
  // by anything, so deriving from actual submitted pay items is what makes
  // those filters correspond to real data instead of always returning zero
  // results. Scans every report (seed + live, already merged by applyOverlay)
  // rather than just the newest one, since a certification/education/longevity
  // item reported once stays true going forward.
  var CERT_PAY_TYPES = ['tcfp-basic', 'tcfp-intermediate', 'tcfp-advanced', 'tcfp-master', 'certification'];
  var EDU_PAY_TYPES = ['edu-hs', 'edu-associate', 'edu-bachelor', 'edu-master'];
  function applySupplementalFlags(dept) {
    var reports = (dept.salary && dept.salary.reports) || [];
    var hasCert = false, hasEdu = false, hasLongevity = false;
    reports.forEach(function (r) {
      (r.supplemental || []).forEach(function (s) {
        if (!s || !s.type) return;
        if (CERT_PAY_TYPES.indexOf(s.type) !== -1) hasCert = true;
        else if (EDU_PAY_TYPES.indexOf(s.type) !== -1) hasEdu = true;
        else if (s.type === 'longevity') hasLongevity = true;
      });
    });
    if (!hasCert && !hasEdu && !hasLongevity) return dept;
    var d = Object.assign({}, dept);
    d.flags = Object.assign({}, dept.flags, {
      certPay: !!(dept.flags && dept.flags.certPay) || hasCert,
      educationPay: !!(dept.flags && dept.flags.educationPay) || hasEdu,
      longevity: !!(dept.flags && dept.flags.longevity) || hasLongevity
    });
    return d;
  }

  // Marks a department "Department maintained" once its claim has been
  // approved (see js/department.js's writeClaim() + js/admin.js's approval
  // action). departmentMaintained lives at the TOP level of the department
  // object, not under salary — js/derive.js's deriveSummary() already reads
  // dept.departmentMaintained directly, so no derive.js changes are needed.
  function applyClaim(dept, claimed) {
    if (!claimed) return dept;
    var d = Object.assign({}, dept);
    d.departmentMaintained = true;
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

  var FireAggregate = { submissionToReport: submissionToReport, applyOverlay: applyOverlay, applyStepPlan: applyStepPlan, applyClaim: applyClaim, applyCivilService: applyCivilService, applySupplementalFlags: applySupplementalFlags, summarize: summarize, toMs: toMs, money: money };
  if (typeof window !== 'undefined') window.FireAggregate = FireAggregate;
  if (typeof module !== 'undefined' && module.exports) module.exports = FireAggregate;
})();
