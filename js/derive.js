/*
 * derive.js — The single shared "derive a department's displayed values" function.
 *
 * Used by BOTH the browser (data.js) and the Node build (scripts/build-site.js)
 * so the static crawlable page and the live page compute identical numbers.
 * Pure: depends only on FireSalaryLib + FireConsensus, resolved from window
 * (browser) or require (Node). Exposes window.FireDerive / module.exports.
 */
(function () {
  'use strict';

  var Lib = (typeof window !== 'undefined' && window.FireSalaryLib) || (typeof require === 'function' && require('./salary-lib.js'));
  var C = (typeof window !== 'undefined' && window.FireConsensus) || (typeof require === 'function' && require('./consensus.js'));

  function toMs(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'number') return d;
    if (d && typeof d.toMillis === 'function') return d.toMillis();
    var t = Date.parse(d);
    return isNaN(t) ? null : t;
  }

  // Build cluster-input reports for a given field ('entry' or 'top') from the
  // department's stored reports plus any extra live reports. Extra reports from
  // the live Firestore path carry entry as `.value`; overlay reports carry both
  // `.entry` and `.top`.
  function reportsForField(salary, extra, field) {
    var out = (salary.reports || []).map(function (r) {
      return {
        value: Lib.parseMoney(r[field]),
        contributorId: r.contributorId,
        submittedAt: toMs(r.submittedAt),
        hasSource: !!r.hasSource,
        departmentMaintained: !!r.departmentMaintained
      };
    }).filter(function (r) { return typeof r.value === 'number' && r.value != null; });
    (extra || []).forEach(function (r) {
      var raw = (r[field] != null) ? r[field] : (field === 'entry' ? r.value : null);
      var v = Lib.parseMoney(raw);
      if (typeof v === 'number' && v != null) {
        out.push({
          value: v,
          contributorId: r.contributorId,
          submittedAt: (typeof r.submittedAt === 'number') ? r.submittedAt : toMs(r.submittedAt),
          hasSource: !!r.hasSource,
          departmentMaintained: !!r.departmentMaintained
        });
      }
    });
    return out;
  }

  function uniqueContributorCount(reports) {
    var set = {};
    reports.forEach(function (r) { if (r.contributorId != null) set[r.contributorId] = true; });
    return Object.keys(set).length;
  }

  // now can be injected (tests / deterministic builds); defaults to Date.now().
  function deriveSummary(dept, extraReports, now) {
    now = now || Date.now();
    var s = dept.salary;
    var annualHours = Lib.parseNumber(dept.annualScheduledHours) || Lib.scheduleHours(dept.scheduleType) || 2912;
    var out = {
      hasSalary: false,
      annualHours: annualHours,
      scheduleType: dept.scheduleType || null,
      departmentMaintained: !!dept.departmentMaintained,
      confidence: C.CONFIDENCE.needed,
      freshness: C.FRESHNESS.none,
      contributors: 0,
      hasConflict: false,
      lastUpdated: null
    };
    if (!s || !Array.isArray(s.steps) || s.steps.length === 0) return out;

    out.hasSalary = true;
    var steps = s.steps.slice().sort(function (a, b) { return (a.minimumMonths || 0) - (b.minimumMonths || 0); });
    var first = steps[0], last = steps[steps.length - 1];

    out.steps = steps;
    out.entryBase = Lib.parseMoney(first.baseAnnualSalary);
    out.topBase = Lib.parseMoney(last.baseAnnualSalary);
    out.recruit = Lib.parseMoney(first.baseAnnualSalary);
    out.reportedTop = Lib.parseMoney(last.reportedAnnualCompensation);
    out.reportedEntry = Lib.parseMoney(first.reportedAnnualCompensation);
    var medics = steps.map(function (x) { return Lib.parseMoney(x.paramedicPay) || 0; });
    out.medicPay = Math.max.apply(null, medics.concat(0)) || null;
    out.yearsToTop = Lib.yearsToTop(steps);
    // effectiveHourlyEntry / effectiveHourlyTop are set below, after the displayed
    // entry and top figures are chosen (which may be community-overridden).
    out.includesScheduledOvertime = !!s.includesScheduledOvertime;
    out.includesFlsaOvertime = !!s.includesFlsaOvertime;
    out.effectiveDate = s.effectiveDate || null;
    out.sourceType = s.sourceType || null;
    out.sourceUrl = s.sourceUrl || null;
    out.classification = s.classification || null;

    var flags = dept.flags || {};
    if (flags.paramedicIncentive) {
      var firstMedicStep = steps.find(function (x) { return (Lib.parseMoney(x.paramedicPay) || 0) > 0; });
      if (firstMedicStep) {
        out.entryMedic = Lib.parseMoney(firstMedicStep.baseAnnualSalary) + (Lib.parseMoney(firstMedicStep.paramedicPay) || 0);
      }
    }

    // ── Entry consensus (the headline figure) ──
    var entryReports = reportsForField(s, extraReports, 'entry');
    if (entryReports.length === 0) {
      entryReports = [{
        value: out.entryBase,
        contributorId: 'historical',
        submittedAt: toMs(s.effectiveDate) || now,
        hasSource: !!s.sourceUrl,
        departmentMaintained: !!dept.departmentMaintained
      }];
    }
    var clusters = C.clusterValues(entryReports, { now: now });
    var current = C.selectCurrentCluster(clusters, { now: now });
    out.clusters = clusters;
    out.confidence = C.confidenceLabel(clusters, { now: now });
    out.hasConflict = C.hasRecentConflict(clusters, { now: now });
    out.entry = current ? current.value : out.entryBase;
    out.effectiveHourlyEntry = Lib.effectiveHourly(out.entry, annualHours);

    // ── Top consensus — community-reported top pay overrides the step-derived top ──
    var topReports = reportsForField(s, extraReports, 'top');
    if (topReports.length) {
      var topCurrent = C.selectCurrentCluster(C.clusterValues(topReports, { now: now }), { now: now });
      if (topCurrent) out.topBase = topCurrent.value;
    }
    out.effectiveHourlyTop = Lib.effectiveHourly(out.topBase, annualHours);

    var allReports = entryReports.concat(topReports);
    out.contributors = uniqueContributorCount(allReports);
    var newest = allReports.reduce(function (m, r) { return Math.max(m, r.submittedAt || 0); }, 0) || toMs(s.effectiveDate);
    out.lastUpdated = newest || null;
    out.newestSubmission = newest || null;
    out.oldestCurrent = current ? current.oldest : null;
    out.freshness = C.freshnessBucket(newest, { now: now, effectiveMs: toMs(s.effectiveDate) });
    return out;
  }

  var FireDerive = { deriveSummary: deriveSummary, toMs: toMs };
  if (typeof window !== 'undefined') window.FireDerive = FireDerive;
  if (typeof module !== 'undefined' && module.exports) module.exports = FireDerive;
})();
