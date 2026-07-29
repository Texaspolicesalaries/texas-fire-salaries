/*
 * filters.js — Shared, mostly-pure filter/sort/URL engine.
 *
 * The SAME filter state drives the map and the directory list, and round-trips
 * through the URL query string so any view is shareable. Operates on the derived
 * `dept.summary` produced by data.js. Exposes window.FireFilters.
 */
(function () {
  'use strict';

  // Which query keys we persist. (booleans stored as '1')
  var KEYS = [
    'q', 'city', 'county', 'region', 'zip', 'radius', 'nearLat', 'nearLng',
    'entryMin', 'medicMin', 'topMin', 'maxYtt', 'hourlyMin',
    'hasSteps', 'hasMedic', 'hasCert', 'hasEdu', 'hasLongevity',
    'schedule', 'transport', 'type', 'civil', 'retirement',
    'emt', 'medicReq', 'lateral', 'hiring',
    'fresh6', 'fresh12', 'deptMaint', 'hasSource', 'multiConfirm', 'complete', 'noDisputed',
    'sort', 'dir', 'view'
  ];

  function defaults() {
    return {
      q: '', city: '', county: '', region: '', zip: '', radius: '', nearLat: '', nearLng: '',
      entryMin: '', medicMin: '', topMin: '', maxYtt: '', hourlyMin: '',
      hasSteps: false, hasMedic: false, hasCert: false, hasEdu: false, hasLongevity: false,
      schedule: '', transport: '', type: '', civil: '', retirement: '',
      emt: false, medicReq: false, lateral: false, hiring: false,
      fresh6: false, fresh12: false, deptMaint: false, hasSource: false,
      multiConfirm: false, complete: false, noDisputed: false,
      sort: 'name', dir: 'asc', view: 'map'
    };
  }

  function fromURL(search) {
    var p = new URLSearchParams(search || window.location.search);
    var st = defaults();
    KEYS.forEach(function (k) {
      if (!p.has(k)) return;
      var v = p.get(k);
      if (typeof st[k] === 'boolean') st[k] = (v === '1' || v === 'true');
      else st[k] = v;
    });
    return st;
  }

  function toParams(st) {
    var base = defaults();
    var p = new URLSearchParams();
    KEYS.forEach(function (k) {
      var v = st[k];
      if (typeof base[k] === 'boolean') { if (v) p.set(k, '1'); }
      else if (v !== '' && v != null && v !== base[k]) p.set(k, v);
    });
    return p;
  }

  function toQueryString(st) { var s = toParams(st).toString(); return s ? ('?' + s) : ''; }

  // Persist to URL without a reload.
  function syncURL(st) {
    var qs = toQueryString(st);
    var url = window.location.pathname + qs + window.location.hash;
    window.history.replaceState(null, '', url);
  }

  function num(v) { var n = parseFloat(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    var toRad = function (d) { return d * Math.PI / 180; };
    var R = 3958.8;
    var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Resolve a distance origin: explicit near-me coords, else a ZIP that matches a
  // department centroid (offline-friendly; real geocoding is a later enhancement).
  function resolveOrigin(st, departments) {
    if (st.nearLat && st.nearLng) return { lat: num(st.nearLat), lng: num(st.nearLng) };
    if (st.zip) {
      var d = departments.find(function (x) { return x.zip === st.zip; });
      if (d) return { lat: d.lat, lng: d.lng };
    }
    return null;
  }

  function distanceFor(dept, origin) {
    if (!origin || typeof dept.lat !== 'number') return null;
    return haversineMiles(origin.lat, origin.lng, dept.lat, dept.lng);
  }

  // Build a predicate. ctx: { origin }
  function makePredicate(st, ctx) {
    ctx = ctx || {};
    var origin = ctx.origin || null;
    var radius = num(st.radius);
    return function (d) {
      var s = d.summary || {};
      var f = d.flags || {};
      // location
      if (st.city && d.city !== st.city) return false;
      if (st.county && d.county !== st.county) return false;
      if (st.region && d.region !== st.region) return false;
      if (origin && radius) {
        var dist = distanceFor(d, origin);
        if (dist == null || dist > radius) return false;
      }
      // compensation
      if (st.entryMin && !(s.entry >= num(st.entryMin))) return false;
      if (st.medicMin && !(s.entryMedic >= num(st.medicMin))) return false;
      if (st.topMin && !(s.topBase >= num(st.topMin))) return false;
      if (st.maxYtt && !(s.yearsToTop != null && s.yearsToTop <= num(st.maxYtt))) return false;
      if (st.hourlyMin && !(s.effectiveHourlyEntry >= num(st.hourlyMin))) return false;
      if (st.hasSteps && !(s.steps && s.steps.length)) return false;
      if (st.hasMedic && !f.paramedicIncentive) return false;
      if (st.hasCert && !f.certPay) return false;
      if (st.hasEdu && !f.educationPay) return false;
      if (st.hasLongevity && !f.longevity) return false;
      // work conditions
      if (st.schedule && d.scheduleType !== st.schedule) return false;
      if (st.transport && d.transportStatus !== st.transport) return false;
      if (st.type && d.departmentType !== st.type) return false;
      if (st.civil === 'yes' && !d.civilService) return false;
      if (st.civil === 'no' && d.civilService) return false;
      if (st.retirement && d.retirementSystem !== st.retirement) return false;
      if (st.emt && !f.emtRequired) return false;
      if (st.medicReq && !f.paramedicRequired) return false;
      if (st.lateral && !f.lateralsAccepted) return false;
      if (st.hiring && d.hiringStatus !== 'hiring') return false;
      // data quality
      if (st.fresh6 && !isWithinMonths(s.lastUpdated, 6)) return false;
      if (st.fresh12 && !isWithinMonths(s.lastUpdated, 12)) return false;
      if (st.deptMaint && !s.departmentMaintained) return false;
      if (st.hasSource && !s.sourceUrl) return false;
      if (st.multiConfirm && !(s.contributors >= 2)) return false;
      if (st.complete && !(s.hasSalary && s.steps && s.steps.length >= 2)) return false;
      if (st.noDisputed && s.hasConflict) return false;
      return true;
    };
  }

  function isWithinMonths(ms, months) {
    if (!ms) return false;
    return (Date.now() - ms) <= months * 30.437 * 24 * 3600 * 1000;
  }

  function comparator(sort, dir, ctx) {
    ctx = ctx || {};
    var origin = ctx.origin || null;
    var mult = dir === 'desc' ? -1 : 1;
    var num2 = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
    function keyVal(d) {
      var s = d.summary || {};
      switch (sort) {
        case 'entry': return num2(s.entry);
        case 'medic': return num2(s.entryMedic);
        case 'top': return num2(s.topBase);
        case 'ytt': return num2(s.yearsToTop);
        case 'hourly': return num2(s.effectiveHourlyEntry);
        case 'updated': return num2(s.lastUpdated);
        case 'confirmations': return num2(s.contributors);
        case 'distance': return origin ? distanceFor(d, origin) : null;
        default: return null; // name handled separately
      }
    }
    return function (a, b) {
      if (sort === 'name' || !sort) {
        return mult * a.name.localeCompare(b.name);
      }
      var av = keyVal(a), bv = keyVal(b);
      // Nulls always sort last regardless of direction.
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.name.localeCompare(b.name);
      // distance default ascending feels natural; others follow dir
      if (sort === 'distance') return (av - bv);
      return mult * (av - bv);
    };
  }

  // Count how many non-default filters are active (for the "N filters" badge).
  function activeCount(st) {
    var base = defaults();
    var n = 0;
    KEYS.forEach(function (k) {
      if (k === 'sort' || k === 'dir' || k === 'view' || k === 'q') return;
      if (typeof base[k] === 'boolean') { if (st[k]) n++; }
      else if (st[k] !== '' && st[k] != null && st[k] !== base[k]) n++;
    });
    return n;
  }

  window.FireFilters = {
    KEYS: KEYS,
    defaults: defaults,
    fromURL: fromURL,
    toParams: toParams,
    toQueryString: toQueryString,
    syncURL: syncURL,
    makePredicate: makePredicate,
    comparator: comparator,
    resolveOrigin: resolveOrigin,
    distanceFor: distanceFor,
    haversineMiles: haversineMiles,
    activeCount: activeCount,
    num: num
  };
})();
