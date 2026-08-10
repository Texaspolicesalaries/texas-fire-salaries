/*
 * home.js — Homepage: live search, statewide coverage, map preview, and recent
 * salary updates. Reads everything from FireData.
 */
(function () {
  'use strict';
  var UI = window.FireUI;

  function monthsAgo(ms, n) { return ms && (Date.now() - ms) <= n * 30.437 * 24 * 3600 * 1000; }

  document.addEventListener('DOMContentLoaded', function () {
    window.FireData.load().then(function () {
      wireSearch();
      renderStats();
      renderMapPreview();
      renderFeed();
    }).catch(function (e) { console.error(e); });
  });

  function wireSearch() {
    var input = document.getElementById('home-search');
    var results = document.getElementById('home-search-results');
    if (!input || !results) return;
    var active = -1, items = [];
    function render(list, q) {
      items = list;
      if (!list.length) {
        if (!q) { results.classList.remove('open'); results.innerHTML = ''; return; }
        // A dead end ("nothing found") turned into a contribution opportunity —
        // most misses here are real Texas departments simply not added yet,
        // not typos, since coverage is still growing region by region.
        results.innerHTML = '<div class="search-empty">' +
          '<p><strong>' + UI.esc(q) + '</strong> isn\'t in the database yet.</p>' +
          '<a href="/submit.html?mode=add">Submit this department →</a>' +
          '<a href="/departments.html">Browse current coverage →</a>' +
          '</div>';
        results.classList.add('open');
        return;
      }
      results.innerHTML = list.map(function (d) {
        var s = d.summary || {};
        return '<a href="/departments/' + UI.esc(d.slug) + '/"><span>' + UI.esc(d.name) +
          '</span><span class="r-loc">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + ' Co. · ' +
          (s.hasSalary ? UI.money(s.entry) + ' entry' : 'needs data') + '</span></a>';
      }).join('');
      results.classList.add('open');
      active = -1;
    }
    // Tracked debounced (not per keystroke) — fires once the user pauses,
    // same as a search a visitor actually "ran" rather than every character.
    var searchTrackTimer = null;
    input.addEventListener('input', function () {
      var q = input.value.trim();
      var list = q ? window.FireData.search(q) : [];
      render(list, q);
      clearTimeout(searchTrackTimer);
      if (q && window.FireAnalytics) {
        searchTrackTimer = setTimeout(function () { window.FireAnalytics.trackSearch('home', q, list.length); }, 600);
      }
    });
    input.addEventListener('keydown', function (e) {
      var links = Array.prototype.slice.call(results.querySelectorAll('a'));
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, links.length - 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); }
      else if (e.key === 'Enter') {
        if (active >= 0 && links[active]) { window.location = links[active].href; }
        else if (items.length === 1) { window.location = '/departments/' + items[0].slug + '/'; }
        else { window.location = '/departments.html?q=' + encodeURIComponent(input.value.trim()); }
        return;
      } else return;
      links.forEach(function (l, i) { l.classList.toggle('active', i === active); });
    });
    document.addEventListener('click', function (e) {
      if (!results.contains(e.target) && e.target !== input) results.classList.remove('open');
    });
  }

  function renderStats() {
    var all = window.FireData.all();
    var withSalary = all.filter(function (d) { return d.summary.hasSalary; });
    var updated12 = withSalary.filter(function (d) { return monthsAgo(d.summary.lastUpdated, 12); });
    var withSteps = withSalary.filter(function (d) { return d.summary.steps && d.summary.steps.length >= 3; });
    var needed = all.length - withSalary.length;
    var pct = all.length ? Math.round(withSalary.length / all.length * 100) : 0;

    setStat('stat-depts', all.length.toLocaleString());
    setStat('stat-salary', withSalary.length.toLocaleString());
    setStat('stat-stepplans', withSteps.length.toLocaleString());
    setStat('stat-needed', needed.toLocaleString());

    var status = document.getElementById('coverage-status');
    if (status) status.textContent = updated12.length.toLocaleString() + ' updated in the last 12 months';
    var progress = document.getElementById('coverage-progress');
    if (progress) {
      progress.setAttribute('aria-valuenow', String(pct));
      var bar = progress.querySelector('span');
      if (bar) bar.style.width = pct + '%';
    }

    // Honest scope note, computed from the real data rather than hardcoded —
    // this automatically stops singling out "North Texas" once a second
    // region is actually covered, with no copy edit needed later.
    var scope = document.getElementById('coverage-scope');
    if (scope) {
      var byRegion = {};
      all.forEach(function (d) { if (d.region) byRegion[d.region] = (byRegion[d.region] || 0) + 1; });
      var regionIds = Object.keys(byRegion);
      if (regionIds.length <= 1) {
        var name = regionIds.length ? window.FireData.regionName(regionIds[0]) : 'Texas';
        scope.innerHTML = '<span aria-hidden="true">◔</span><span>Currently covers <strong>' + name + '</strong> (' + byRegion[regionIds[0]] + ' departments). More regions are being added as the community grows it — <a href="/submit.html">add yours →</a></span>';
      } else {
        var parts = regionIds.map(function (r) { return window.FireData.regionName(r) + ' (' + byRegion[r] + ')'; });
        scope.innerHTML = '<span aria-hidden="true">◔</span><span>Covers ' + regionIds.length + ' regions so far: ' + parts.join(', ') + '.</span>';
      }
    }
  }

  function setStat(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }

  function renderMapPreview() {
    var host = document.getElementById('home-map');
    if (!host || !window.L) return;
    var map = window.L.map(host, {
      zoomControl: false,
      scrollWheelZoom: false,
      dragging: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false
    }).setView([31.1, -99.4], 5);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 19,
      subdomains: 'abcd'
    }).addTo(map);

    var colors = {
      current: '#3D8178',
      strong: '#23645C',
      outdated: '#B98A2E',
      conflict: '#B93F1B',
      dept: '#174A7E',
      missing: '#7D8790'
    };
    var bounds = window.L.latLngBounds();
    window.FireData.all().forEach(function (d) {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      var status = UI.pinStatus(d);
      window.L.circleMarker([d.lat, d.lng], {
        radius: status === 'missing' ? 4 : 5,
        color: '#fff',
        weight: 1.5,
        fillColor: colors[status] || colors.current,
        fillOpacity: .92,
        interactive: false
      }).addTo(map);
      bounds.extend([d.lat, d.lng]);
    });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 8, animate: false });
  }

  // The entry figure's raw report history, oldest → newest, reduced to "what
  // it was" and "what it is now". Only distinct values count as a change —
  // a confirmation of the same number isn't news. Values come from the same
  // merged report list derive.js reads, so the "now" matches the site.
  function entryTrail(d) {
    var Lib = window.FireSalaryLib;
    var reps = ((d.salary && d.salary.reports) || [])
      .map(function (r) {
        var v = r ? Lib.parseMoney(r.entry) : null;
        if (v == null) return null;
        var t = (typeof r.submittedAt === 'number') ? r.submittedAt : Date.parse(r.submittedAt || '');
        return { v: v, at: isNaN(t) ? 0 : t };
      })
      .filter(Boolean)
      .sort(function (a, b) { return a.at - b.at; });
    if (!reps.length) return null;
    // Distinct means distinct in whole dollars — the figures render rounded, so
    // a cents-level difference would show as "$76,208 → $76,208", a non-change.
    var now = reps[reps.length - 1].v, prev = null;
    for (var i = reps.length - 2; i >= 0; i--) { if (Math.round(reps[i].v) !== Math.round(now)) { prev = reps[i].v; break; } }
    return { now: now, prev: prev };
  }

  function renderFeed() {
    var all = window.FireData.all();
    var events = [];
    all.forEach(function (d) {
      var s = d.summary;
      if (!s.hasSalary || !s.lastUpdated) return;
      var kind = s.departmentMaintained ? 'Department maintained'
        : (s.steps && s.steps.length >= 3 ? 'New step plan'
        : (s.hasConflict ? 'Conflicting report' : 'Updated entry salary'));
      events.push({ dept: d, when: s.lastUpdated, kind: kind });
    });
    events.sort(function (a, b) { return b.when - a.when; });
    var feed = document.getElementById('recent-feed');
    if (!feed) return;
    if (!events.length) { feed.innerHTML = '<p class="muted">No community updates yet — be the first to contribute.</p>'; return; }
    feed.innerHTML = events.slice(0, 5).map(function (e) {
      var iso = new Date(e.when).toISOString();
      var label = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(e.when));
      // The number IS the story: an entry-salary update shows before → after
      // when a prior distinct value exists; everything else shows the current
      // figure so the feed line carries real information, not just a headline.
      var s = e.dept.summary || {};
      var trail = entryTrail(e.dept);
      var delta = '';
      if (e.kind === 'Updated entry salary' && trail && trail.prev != null) {
        delta = UI.money(trail.prev) + ' → ' + UI.money(trail.now) + ' entry';
      } else if (s.hasSalary && s.entry != null) {
        delta = UI.money(s.entry) + ' entry' +
          (e.kind === 'New step plan' && s.topBase ? ' · ' + UI.money(s.topBase) + ' top' : '');
      }
      return '<div class="feed-item">' +
        '<span class="feed-kind">' + UI.esc(e.kind) + '</span>' +
        '<a href="/departments/' + UI.esc(e.dept.slug) + '/">' + UI.esc(e.dept.name) + '</a>' +
        (delta ? '<span class="feed-delta">' + UI.esc(delta) + '</span>' : '') +
        '<time class="feed-when" datetime="' + iso + '">' + UI.esc(label) + '</time>' +
      '</div>';
    }).join('') +
      '<div class="home-feed-more"><a href="/departments?nav=20260729">Browse all departments →</a></div>';
  }
})();
