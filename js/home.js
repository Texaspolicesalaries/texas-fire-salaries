/*
 * home.js — Homepage: live search, dynamic statewide summary cards, launch
 * progress, and recent community updates. Reads everything from FireData.
 */
(function () {
  'use strict';
  var UI = window.FireUI;

  function monthsAgo(ms, n) { return ms && (Date.now() - ms) <= n * 30.437 * 24 * 3600 * 1000; }

  document.addEventListener('DOMContentLoaded', function () {
    window.FireData.load().then(function () {
      wireSearch();
      renderStats();
      renderProgress();
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
    var contributors = countContributors(all);
    var updatesThisMonth = withSalary.filter(function (d) { return monthsAgo(d.summary.lastUpdated, 1); }).length;

    setStat('stat-depts', all.length.toLocaleString());
    setStat('stat-updated', updated12.length.toLocaleString());
    setStat('stat-stepplans', withSteps.length.toLocaleString());
    setStat('stat-contributors', Math.max(contributors, 0).toLocaleString());
    setStat('stat-updates-month', updatesThisMonth.toLocaleString());
  }

  // Count real community contributors — exclude seed/import/historical markers.
  var NON_COMMUNITY = { historical: 1, 'dfw-fire-import': 1 };
  function countContributors(all) {
    var set = {};
    all.forEach(function (d) {
      ((d.salary && d.salary.reports) || []).forEach(function (r) {
        if (r.contributorId && !NON_COMMUNITY[r.contributorId] && !/^(import|seed)/.test(r.contributorId)) set[r.contributorId] = true;
      });
    });
    return Object.keys(set).length;
  }

  function setStat(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }

  function renderProgress() {
    var all = window.FireData.all();
    var withSalary = all.filter(function (d) { return d.summary.hasSalary; }).length;
    var need = all.length - withSalary;
    var updatedYr = all.filter(function (d) { return monthsAgo(d.summary.lastUpdated, 12); }).length;
    var pct = all.length ? Math.round(withSalary / all.length * 100) : 0;
    var wrap = document.getElementById('launch-progress');
    if (!wrap) return;
    wrap.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem">' +
        '<strong style="font-size:1.1rem">' + withSalary + ' departments with salary information</strong>' +
        '<span class="muted">' + updatedYr + ' updated this year</span>' +
      '</div>' +
      '<div class="progress-bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="Departments with salary data"><span style="width:' + pct + '%"></span></div>' +
      '<p class="muted" style="margin:.75rem 0 0;font-size:.9rem">' + need.toLocaleString() +
        ' listed departments still need community submissions. <a href="/departments.html?complete=0">Browse departments that need data →</a></p>';
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
    feed.innerHTML = events.slice(0, 8).map(function (e) {
      return '<div class="feed-item">' +
        '<span class="feed-kind">' + UI.esc(e.kind) + '</span>' +
        '<a href="/departments/' + UI.esc(e.dept.slug) + '/">' + UI.esc(e.dept.name) + '</a>' +
        '<span class="feed-when">' + UI.relTime(e.when) + '</span>' +
      '</div>';
    }).join('');
  }
})();
