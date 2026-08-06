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
  // `.entry` and `.top`. `disputeCount` (0 if none) rides along on each report so
  // the winning cluster's dispute count can be surfaced after selection below —
  // scripts/export-overlay.js already dropped anything that hit the revert
  // threshold before this ever runs, so whatever's left is by definition either
  // undisputed or disputed-but-below-threshold.
  function reportsForField(salary, extra, field) {
    var out = (salary.reports || []).map(function (r) {
      return {
        value: Lib.parseMoney(r[field]),
        contributorId: r.contributorId,
        submittedAt: toMs(r.submittedAt),
        hasSource: !!r.hasSource,
        departmentMaintained: !!r.departmentMaintained,
        trusted: !!r.trusted,
        disputeCount: r[field + 'DisputeCount'] || 0
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
          departmentMaintained: !!r.departmentMaintained,
          trusted: !!r.trusted,
          disputeCount: r[field + 'DisputeCount'] || 0
        });
      }
    });
    return out;
  }

  // The winning cluster's dispute count. Takes the max across its submissions
  // rather than assuming they all agree — a seed-baked-in report sharing the
  // disputed value never gets annotated with a count (only live overlay reports
  // do, see scripts/export-overlay.js's applyValueDisputes), so relying on
  // "the first submission" could silently read 0 off an unrelated report.
  function clusterDisputeCount(cluster) {
    if (!cluster || !cluster.submissions || !cluster.submissions.length) return 0;
    return cluster.submissions.reduce(function (max, s) { return Math.max(max, s.disputeCount || 0); }, 0);
  }

  function uniqueContributorCount(reports) {
    var set = {};
    reports.forEach(function (r) { if (r.contributorId != null) set[r.contributorId] = true; });
    return Object.keys(set).length;
  }

  // now can be injected (tests / deterministic builds); defaults to Date.now().
  //
  // Deliberately does NOT bail out early just because a department has no seed
  // salary.steps (e.g. a brand-new department auto-promoted from a ZIP-geocoded
  // request — see scripts/export-overlay.js — starts with none at all). Live
  // community reports are still clustered even with zero seed baseline, so a
  // department's very first submission is never silently dropped.
  function deriveSummary(dept, extraReports, now) {
    now = now || Date.now();
    var s = dept.salary || {};
    var hasSteps = Array.isArray(s.steps) && s.steps.length > 0;
    // 2912 is a last-resort assumption (a 24/48 cycle), not a reported figure.
    // A department on a modified rotation that didn't supply its hours would
    // otherwise show "Reported annual hours 2,912" — a number nobody reported —
    // and an effective hourly derived from it. Track which it is so the page can
    // say so instead of asserting a fact.
    var knownHours = Lib.parseNumber(dept.annualScheduledHours) || Lib.scheduleHours(dept.scheduleType);
    var annualHours = knownHours || 2912;
    var out = {
      hasSalary: false,
      annualHours: annualHours,
      annualHoursKnown: knownHours != null,
      scheduleType: dept.scheduleType || null,
      departmentMaintained: !!dept.departmentMaintained,
      confidence: C.CONFIDENCE.needed,
      freshness: C.FRESHNESS.none,
      contributors: 0,
      hasConflict: false,
      lastUpdated: null
    };

    var steps = hasSteps ? s.steps.slice().sort(function (a, b) { return (a.minimumMonths || 0) - (b.minimumMonths || 0); }) : [];
    var first = steps[0], last = steps[steps.length - 1];

    if (hasSteps) {
      out.steps = steps;
      out.entryBase = Lib.parseMoney(first.baseAnnualSalary);
      out.topBase = Lib.parseMoney(last.baseAnnualSalary);
      out.reportedTop = Lib.parseMoney(last.reportedAnnualCompensation);
      out.reportedEntry = Lib.parseMoney(first.reportedAnnualCompensation);
      // Midpoint: the middle step of a 3+-step plan (entry / midpoint / top is a
      // common pay-scale shape). Null for a simple 2-step entry/top-only plan —
      // there's no meaningful midpoint to show. Community reports (below) can
      // still supply one even when the seed has no multi-step plan at all.
      var midStep = steps.length >= 3 ? steps[Math.floor((steps.length - 1) / 2)] : null;
      out.midpoint = midStep ? Lib.parseMoney(midStep.baseAnnualSalary) : null;
      out.reportedMidpoint = midStep ? Lib.parseMoney(midStep.reportedAnnualCompensation) : null;
      var medics = steps.map(function (x) { return Lib.parseMoney(x.paramedicPay) || 0; });
      out.medicPay = Math.max.apply(null, medics.concat(0)) || null;
      out.yearsToTop = Lib.yearsToTop(steps);
      // A single reported step (often "entry" with no real progression data)
      // makes "years to top" trivially 0 and career-earnings totals a flat,
      // falsely precise multiple of one number — flagged here so the UI can
      // label it plainly instead of presenting it as a real step plan.
      out.singleRatePlan = steps.length <= 1;
    } else {
      out.entryBase = null; out.topBase = null;
      out.reportedTop = null; out.reportedEntry = null;
      out.midpoint = null; out.reportedMidpoint = null;
      out.medicPay = null; out.yearsToTop = null;
      out.singleRatePlan = false;
    }
    // effectiveHourlyEntry / effectiveHourlyTop are set below, after the displayed
    // entry and top figures are chosen (which may be community-overridden).
    // Seed data can declare this, and so can a community submission tagged
    // "Base + scheduled overtime" — either way the page must warn that the
    // figure is not comparable with a pure base-pay one.
    out.includesScheduledOvertime = !!s.includesScheduledOvertime ||
      (s.reports || []).concat(extraReports || []).some(function (r) { return r && r.includesScheduledOvertime; });
    out.planNotes = s.planNotes || null;
    out.includesFlsaOvertime = !!s.includesFlsaOvertime;
    out.effectiveDate = s.effectiveDate || null;
    out.sourceType = s.sourceType || null;
    out.sourceUrl = s.sourceUrl || null;
    // Fall back to the newest report that carries a link. Must come AFTER the
    // assignment above, which would otherwise clobber it back to null: a
    // department whose figures came from ordinary submissions has no
    // seed/step-plan source of its own, and reporting "Source supplied: No"
    // when the contributor pasted their department's official pay page is worse
    // than saying nothing.
    if (!out.sourceUrl) {
      var sourced = (s.reports || []).concat(extraReports || [])
        .filter(function (r) { return r && (r.sourceUrl || r.sourceFile); })
        .sort(function (a, b) { return (toMs(b.submittedAt) || 0) - (toMs(a.submittedAt) || 0); })[0];
      if (sourced) out.sourceUrl = sourced.sourceUrl || sourced.sourceFile;
    }
    out.classification = s.classification || null;
    // Lets the page target a "flag this pay-step plan" dispute at the exact live
    // submission currently showing — null for seed-only data, which has no
    // submission to flag against.
    out.stepPlanId = s.stepPlanId || null;
    out.stepPlanDisputed = !!s.stepPlanDisputed;
    out.stepPlanDisputeCount = s.stepPlanDisputeCount || 0;

    // ── Entry consensus (the headline figure) — falls back to the seed's
    // historical step value only when one actually exists.
    var entryReports = reportsForField(s, extraReports, 'entry');
    if (entryReports.length === 0 && out.entryBase != null) {
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
    out.entryDisputeCount = clusterDisputeCount(current);
    // How many DISTINCT trusted contributors (see scripts/export-overlay.js's
    // computeTrustedContributors) are behind the currently-winning entry value
    // — shown as a small note on the confidence card, not folded into the
    // confidence label itself.
    out.trustedContributors = (current && current.trustedContributors) || 0;

    // ── Top consensus — community-reported top pay overrides the step-derived top ──
    var topReports = reportsForField(s, extraReports, 'top');
    out.topDisputeCount = 0;
    if (topReports.length) {
      var topCurrent = C.selectCurrentCluster(C.clusterValues(topReports, { now: now }), { now: now });
      if (topCurrent) { out.topBase = topCurrent.value; out.topDisputeCount = clusterDisputeCount(topCurrent); }
    }
    out.effectiveHourlyTop = Lib.effectiveHourly(out.topBase, annualHours);

    // ── Midpoint consensus — same pattern as top; a community "Midpoint pay"
    // submission overrides the seed's middle-step value (or supplies one where
    // there was none at all, e.g. a simple entry/top-only or brand-new plan). ──
    var midpointReports = reportsForField(s, extraReports, 'midpoint');
    out.midpointDisputeCount = 0;
    if (midpointReports.length) {
      var midCurrent = C.selectCurrentCluster(C.clusterValues(midpointReports, { now: now }), { now: now });
      if (midCurrent) { out.midpoint = midCurrent.value; out.midpointDisputeCount = clusterDisputeCount(midCurrent); }
    }
    out.effectiveHourlyMidpoint = Lib.effectiveHourly(out.midpoint, annualHours);

    // ── Recruit/academy pay consensus — same clustering pattern as midpoint,
    // but deliberately never derived from steps[] (which model progression
    // AFTER graduating to Firefighter). Falls back to the seed's standalone
    // salary.recruitPay; a community "Recruit / academy pay" submission (Single
    // mode's Position: Recruit, or Plan mode's optional field) overrides it,
    // clustering across contributors exactly like entry/top/midpoint do. See
    // data/schema.md and js/submit.js.
    out.recruit = Lib.parseMoney(s.recruitPay);
    var recruitReports = reportsForField(s, extraReports, 'recruit');
    out.recruitDisputeCount = 0;
    if (recruitReports.length) {
      var recruitCurrent = C.selectCurrentCluster(C.clusterValues(recruitReports, { now: now }), { now: now });
      if (recruitCurrent) { out.recruit = recruitCurrent.value; out.recruitDisputeCount = clusterDisputeCount(recruitCurrent); }
    }

    // ── Reported total compensation consensus — kept on its own track, never
    // merged into entry/topBase/midpoint. A submission tagged "Reported total
    // compensation" lands here instead, so it can't silently masquerade as base
    // pay in comparisons (compare.js's "reported" mode is what displays this).
    var reportedEntryReports = reportsForField(s, extraReports, 'reportedEntry');
    if (reportedEntryReports.length) {
      var reCurrent = C.selectCurrentCluster(C.clusterValues(reportedEntryReports, { now: now }), { now: now });
      if (reCurrent) out.reportedEntry = reCurrent.value;
    }
    var reportedTopReports = reportsForField(s, extraReports, 'reportedTop');
    if (reportedTopReports.length) {
      var rtCurrent = C.selectCurrentCluster(C.clusterValues(reportedTopReports, { now: now }), { now: now });
      if (rtCurrent) out.reportedTop = rtCurrent.value;
    }
    var reportedMidpointReports = reportsForField(s, extraReports, 'reportedMidpoint');
    if (reportedMidpointReports.length) {
      var rmCurrent = C.selectCurrentCluster(C.clusterValues(reportedMidpointReports, { now: now }), { now: now });
      if (rmCurrent) out.reportedMidpoint = rmCurrent.value;
    }

    // ── Admin field overrides ── an admin-set correction always wins over
    // whatever consensus picked, applied last so it can't be out-voted by
    // any number of community/department reports — see js/aggregate.js's
    // applyFieldOverrides. `locked` just controls whether the confidence UI
    // shows a padlock; the override itself always takes effect either way
    // for as long as it's set (an admin clears it by removing the override,
    // not by waiting for consensus to catch up).
    var fo = dept.fieldOverrides || {};
    if (fo.entry && fo.entry.value != null) {
      out.entry = fo.entry.value;
      out.entryLocked = !!fo.entry.locked;
      out.entryOverrideNote = fo.entry.note || null;
      out.effectiveHourlyEntry = Lib.effectiveHourly(out.entry, annualHours);
    }
    if (fo.top && fo.top.value != null) {
      out.topBase = fo.top.value;
      out.topLocked = !!fo.top.locked;
      out.topOverrideNote = fo.top.note || null;
      out.effectiveHourlyTop = Lib.effectiveHourly(out.topBase, annualHours);
    }
    if (fo.midpoint && fo.midpoint.value != null) {
      out.midpoint = fo.midpoint.value;
      out.midpointLocked = !!fo.midpoint.locked;
      out.midpointOverrideNote = fo.midpoint.note || null;
      out.effectiveHourlyMidpoint = Lib.effectiveHourly(out.midpoint, annualHours);
    }
    if ((fo.entry && fo.entry.value != null) || (fo.top && fo.top.value != null) || (fo.midpoint && fo.midpoint.value != null)) {
      out.hasSalary = true;
    }

    // Supplemental pay rides on the raw report objects, not on any single
    // clustered field, so it's read straight off salary.reports rather than the
    // per-field pools above (those are filtered to reports carrying that one
    // figure, and a supplemental-only submission carries none of them).
    out.supplemental = Lib.consolidateSupplemental((s.reports || []).concat(extraReports || []));

    var allReports = entryReports.concat(topReports, midpointReports, reportedEntryReports, reportedTopReports, reportedMidpointReports);
    out.contributors = uniqueContributorCount(allReports);
    var newest = allReports.reduce(function (m, r) { return Math.max(m, r.submittedAt || 0); }, 0) || toMs(s.effectiveDate);
    out.lastUpdated = newest || null;
    out.newestSubmission = newest || null;
    out.oldestCurrent = current ? current.oldest : null;
    out.freshness = C.freshnessBucket(newest, { now: now, effectiveMs: toMs(s.effectiveDate) });
    // hasSalary if there's a seed plan OR any live consensus figure came through —
    // a department that's never had any salary data reported stays "needed".
    out.hasSalary = hasSteps || out.entry != null || out.topBase != null || out.midpoint != null ||
      out.reportedEntry != null || out.reportedTop != null || out.reportedMidpoint != null;
    return out;
  }

  var FireDerive = { deriveSummary: deriveSummary, toMs: toMs };
  if (typeof window !== 'undefined') window.FireDerive = FireDerive;
  if (typeof module !== 'undefined' && module.exports) module.exports = FireDerive;
})();
