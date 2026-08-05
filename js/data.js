/*
 * data.js — The data layer for Texas Fire Salaries.
 *
 * Single source of truth used by every page. Loads the static seed directory,
 * (optionally) overlays live community submissions from Firestore, and derives
 * each department's DISPLAYED values through the pure consensus + salary math.
 *
 * Nothing here renders DOM. Exposes window.FireData.
 * Depends on globals: FireSalaryLib, FireConsensus (loaded before this file).
 */
(function () {
  'use strict';

  var Lib = window.FireSalaryLib;
  var Derive = window.FireDerive;
  var Agg = window.FireAggregate;
  var NOW = Date.now();

  var SEED_URL = '/data/departments.seed.json';
  // Community consensus, exported to a STATIC file by the build. Merging it costs
  // 0 Firestore reads for visitors (see scripts/export-overlay.js).
  var OVERLAY_URL = '/data/overlay.json';

  var TYPE_LABELS = {
    municipal: 'Municipal fire department',
    esd: 'Emergency services district',
    county: 'County department',
    university: 'University department',
    airport: 'Airport department',
    'fire-rescue-district': 'Fire-rescue district',
    combination: 'Combination department',
    other: 'Other'
  };
  var HIRING_LABELS = { hiring: 'Currently hiring', 'not-hiring': 'Not currently hiring', unknown: 'Hiring status unknown' };

  var state = { loaded: false, departments: [], regions: [], meta: {}, bySlug: {} };

  var FireData = {
    NOW: NOW,
    TYPE_LABELS: TYPE_LABELS,
    HIRING_LABELS: HIRING_LABELS,
    load: load,
    all: function () { return state.departments; },
    get: function (slug) { return state.bySlug[slug] || null; },
    regions: function () { return state.regions; },
    meta: function () { return state.meta; },
    regionName: function (id) { var r = state.regions.find(function (x) { return x.id === id; }); return r ? r.name : id; },
    typeLabel: function (t) { return TYPE_LABELS[t] || t || '—'; },
    counties: function () {
      var set = {}; state.departments.forEach(function (d) { if (d.county) set[d.county] = true; });
      return Object.keys(set).sort();
    },
    cities: function () {
      var set = {}; state.departments.forEach(function (d) { if (d.city) set[d.city] = true; });
      return Object.keys(set).sort();
    },
    search: search,
    deriveSummary: deriveSummary,
    fetchDepartmentReports: fetchDepartmentReports,
    toMs: toMs
  };
  window.FireData = FireData;

  var _loadPromise = null;
  function load() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = Promise.all([
      fetch(SEED_URL, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('seed ' + r.status); return r.json(); }),
      // Overlay is optional — a missing file just means no community edits yet.
      fetch(OVERLAY_URL, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (arr) {
      var json = arr[0];
      var reports = (arr[1] && arr[1].reports) || {};
      // Community-added departments (auto-geocoded from a ZIP by export-overlay.js)
      // — merged in alongside the owner-curated seed, same 0-Firestore-reads path.
      var overlayDepts = (arr[1] && arr[1].departments) || [];
      // Live, community-submitted full step plans — supersede the seed's step
      // table (see js/aggregate.js's applyStepPlan for why).
      var stepPlans = (arr[1] && arr[1].stepPlans) || {};
      // Departments with an admin-approved claim — shows the "Department
      // maintained" badge (see js/aggregate.js's applyClaim).
      var claimedSlugs = {};
      ((arr[1] && arr[1].claimedSlugs) || []).forEach(function (slug) { claimedSlugs[slug] = true; });
      // A department-level fact contributors can optionally assert alongside
      // their salary submission (see js/aggregate.js's applyCivilService).
      var civilService = (arr[1] && arr[1].civilService) || {};
      state.meta = json.meta || {};
      state.regions = json.regions || [];
      state.departments = (json.departments || []).concat(overlayDepts).map(function (d) {
        // Merge community reports (static, 0 Firestore reads) before deriving.
        var merged = Agg ? Agg.applyOverlay(d, reports[d.slug]) : d;
        if (Agg) merged = Agg.applySupplementalFlags(merged);
        if (Agg && stepPlans[d.slug]) merged = Agg.applyStepPlan(merged, stepPlans[d.slug]);
        if (Agg && claimedSlugs[d.slug]) merged = Agg.applyClaim(merged, true);
        if (Agg && civilService.hasOwnProperty(d.slug)) merged = Agg.applyCivilService(merged, civilService[d.slug]);
        merged.summary = deriveSummary(merged);
        return merged;
      });
      state.bySlug = {};
      state.departments.forEach(function (d) { state.bySlug[d.slug] = d; });
      state.loaded = true;
      return state;
    });
    return _loadPromise;
  }

  function toMs(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'number') return d;
    if (d && typeof d.toMillis === 'function') return d.toMillis(); // Firestore Timestamp
    var t = Date.parse(d);
    return isNaN(t) ? null : t;
  }

  // Derive everything the UI shows for a department. Delegates to the shared
  // pure module (js/derive.js) so the browser and the static build agree exactly.
  function deriveSummary(dept, extraReports) {
    return Derive.deriveSummary(dept, extraReports, NOW);
  }

  function search(q) {
    if (!q) return [];
    var t = String(q).toLowerCase().trim();
    if (!t) return [];
    return state.departments.filter(function (d) {
      return d.name.toLowerCase().indexOf(t) !== -1 ||
             (d.city && d.city.toLowerCase().indexOf(t) !== -1) ||
             (d.county && d.county.toLowerCase().indexOf(t) !== -1) ||
             (d.zip && d.zip.indexOf(t) === 0);
    }).slice(0, 12);
  }

  // Live overlay: pull community submissions for one department from Firestore.
  // Returns [] when Firebase is unconfigured/unavailable so the page still renders.
  // Mirrors the static overlay path (scripts/export-overlay.js) exactly: only
  // 'published' submissions count (a 'flagged' one hasn't cleared automated
  // moderation yet), and confirmations ("This looks correct") are folded in as
  // ordinary reports too, so the live path and the static build agree.
  async function fetchDepartmentReports(slug) {
    var db = window.FireDB;
    if (!db || !db.ready) return [];
    var F = db.sdk.firestore;
    var reports = [];
    try {
      var qy = F.query(
        F.collection(db.db, 'submissions'),
        F.where('departmentSlug', '==', slug),
        F.where('status', '==', 'published'),
        F.orderBy('submittedAt', 'desc'),
        F.limit(100)
      );
      var snap = await F.getDocs(qy);
      snap.forEach(function (doc) {
        var d = doc.data();
        var pv = d.proposedValues || {};
        var entry = Lib.parseMoney(pv.entry);
        var top = Lib.parseMoney(pv.top);
        var midpoint = Lib.parseMoney(pv.midpoint);
        var reportedEntry = Lib.parseMoney(pv.reportedEntry);
        var reportedTop = Lib.parseMoney(pv.reportedTop);
        var reportedMidpoint = Lib.parseMoney(pv.reportedMidpoint);
        if (entry == null && top == null && midpoint == null && reportedEntry == null && reportedTop == null && reportedMidpoint == null) return;
        reports.push({
          value: entry,
          entry: entry,
          top: top,
          midpoint: midpoint,
          reportedEntry: reportedEntry,
          reportedTop: reportedTop,
          reportedMidpoint: reportedMidpoint,
          contributorId: d.contributorId,
          submittedAt: toMs(d.submittedAt),
          hasSource: !!(d.sourceUrl || d.sourceFile),
          departmentMaintained: d.contributorType === 'department'
        });
      });
    } catch (e) {
      console.warn('[FireData] live reports fetch failed', e);
    }
    try {
      var cqy = F.query(
        F.collection(db.db, 'confirmations'),
        F.where('departmentSlug', '==', slug),
        F.orderBy('createdAt', 'desc'),
        F.limit(100)
      );
      var csnap = await F.getDocs(cqy);
      // Latest confirmation per contributor only — matches dedupeConfirmations()
      // in the static path so a repeat click can't inflate the report count.
      var latestByContributor = {};
      csnap.forEach(function (doc) {
        var d = doc.data();
        var cid = d.contributorId;
        if (!cid || latestByContributor[cid]) return; // already have a more recent one (desc order)
        var entry = Lib.parseMoney(d.confirmedEntry);
        var top = Lib.parseMoney(d.confirmedTop);
        var midpoint = Lib.parseMoney(d.confirmedMidpoint);
        if (entry == null && top == null && midpoint == null) return;
        latestByContributor[cid] = true;
        reports.push({
          value: entry,
          entry: entry,
          top: top,
          midpoint: midpoint,
          contributorId: cid,
          submittedAt: toMs(d.createdAt),
          hasSource: false,
          departmentMaintained: false
        });
      });
    } catch (e) {
      console.warn('[FireData] live confirmations fetch failed', e);
    }
    return reports;
  }
})();
