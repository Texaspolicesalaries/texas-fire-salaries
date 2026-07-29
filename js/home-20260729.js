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
    function render(list) {
      items = list;
      if (!list.length) { results.classList.remove('open'); results.innerHTML = ''; return; }
      results.innerHTML = list.map(function (d) {
        var s = d.summary || {};
        return '<a href="/departments/' + UI.esc(d.slug) + '/"><span>' + UI.esc(d.name) +
          '</span><span class="r-loc">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + ' Co. · ' +
          (s.hasSalary ? UI.money(s.entry) + ' entry' : 'needs data') + '</span></a>';
      }).join('');
      results.classList.add('open');
      active = -1;
    }
    input.addEventListener('input', function () {
      var q = input.value.trim();
      render(q ? window.FireData.search(q) : []);
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
    });
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
      return '<div class="feed-item">' +
        '<span class="feed-kind">' + UI.esc(e.kind) + '</span>' +
        '<a href="/departments/' + UI.esc(e.dept.slug) + '/">' + UI.esc(e.dept.name) + '</a>' +
        '<time class="feed-when" datetime="' + iso + '">' + UI.esc(label) + '</time>' +
      '</div>';
    }).join('') +
      '<div class="home-feed-more"><a href="/departments?nav=20260729">Browse all departments →</a></div>';
  }
})();
