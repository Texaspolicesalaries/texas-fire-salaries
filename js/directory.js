/*
 * directory.js — Department directory (departments.html). List-only view sharing
 * the same filter engine + cards as the map. Sort toolbar, result count, filter
 * drawer, URL-synced state, "needs data" surfacing.
 */
(function () {
  'use strict';
  var UI = window.FireUI, F = window.FireFilters, FU = window.FireFiltersUI, CS = window.FireCompareStore;
  var state, allDepts = [];
  // Card grid vs. compact list — remembered across visits.
  var layout = 'cards';
  try { layout = localStorage.getItem('fireDirLayout') || 'cards'; } catch (e) {}

  var SORTS = [
    ['name', 'Department name'], ['entry', 'Entry pay'], ['medic', 'Paramedic pay'],
    ['top', 'Top pay'], ['ytt', 'Years to top'], ['hourly', 'Effective hourly'],
    ['distance', 'Distance'], ['updated', 'Most recently updated'], ['confirmations', 'Most confirmations']
  ];

  document.addEventListener('DOMContentLoaded', function () {
    state = F.fromURL();
    buildSortUI();
    wireChrome();
    wireSearch();
    wireLayout();
    window.FireData.load().then(function () {
      allDepts = window.FireData.all();
      var host = document.getElementById('filter-panel');
      if (host) { FU.render(host, state); FU.wire(host, state, onChange); }
      refresh();
    });
  });

  function buildSortUI() {
    var sel = document.getElementById('sort-select');
    if (sel) {
      sel.innerHTML = SORTS.map(function (s) { return '<option value="' + s[0] + '"' + (state.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('');
      sel.addEventListener('change', function () { state.sort = sel.value; onChange(); });
    }
    var dir = document.getElementById('sort-dir');
    if (dir) {
      setDirLabel(dir);
      dir.addEventListener('click', function () { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; setDirLabel(dir); onChange(); });
    }
  }
  function setDirLabel(btn) { btn.textContent = state.dir === 'desc' ? '↓ High→Low' : '↑ Low→High'; }

  function wireChrome() {
    var openBtn = document.getElementById('open-filters');
    var drawer = document.getElementById('filter-drawer');
    var closeBtn = document.getElementById('close-filters');
    if (openBtn && drawer) openBtn.addEventListener('click', function () { drawer.classList.add('open'); });
    if (closeBtn && drawer) closeBtn.addEventListener('click', function () { drawer.classList.remove('open'); });
    var applyBtn = document.getElementById('apply-filters');
    if (applyBtn && drawer) applyBtn.addEventListener('click', function () { drawer.classList.remove('open'); });
    var clearBtn = document.getElementById('clear-filters');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      var view = state.view; state = F.defaults(); state.view = view;
      var host = document.getElementById('filter-panel'); if (host) { FU.render(host, state); FU.wire(host, state, onChange); }
      resetSearchInput(); buildSortUI(); onChange();
    });
    CS.onChange(updateTray); updateTray();
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.add-compare');
      if (b) { var added = CS.toggle(b.getAttribute('data-slug')); b.textContent = added ? '✓ Added' : '＋ Compare'; }
    });
  }

  // Free-text search over department name / city / county / ZIP.
  function wireSearch() {
    var input = document.getElementById('dept-search');
    if (!input) return;
    input.value = state.q || '';
    var clearBtn = document.getElementById('dept-search-clear');
    function toggleClear() { if (clearBtn) clearBtn.style.display = (input.value.trim() ? 'flex' : 'none'); }
    input.addEventListener('input', function () { state.q = input.value.trim(); toggleClear(); onChange(); });
    if (clearBtn) clearBtn.addEventListener('click', function () { input.value = ''; state.q = ''; toggleClear(); onChange(); input.focus(); });
    toggleClear();
  }

  function matchesQuery(d, q) {
    return d.name.toLowerCase().indexOf(q) !== -1 ||
      (d.city && d.city.toLowerCase().indexOf(q) !== -1) ||
      (d.county && d.county.toLowerCase().indexOf(q) !== -1) ||
      (d.zip && String(d.zip).indexOf(q) === 0);
  }

  function resetSearchInput() { var si = document.getElementById('dept-search'); if (si) si.value = ''; var cb = document.getElementById('dept-search-clear'); if (cb) cb.style.display = 'none'; }

  // Cards <-> compact list toggle.
  function wireLayout() {
    var wrap = document.getElementById('layout-toggle');
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-layout]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-layout') === layout);
      b.addEventListener('click', function () {
        layout = b.getAttribute('data-layout');
        try { localStorage.setItem('fireDirLayout', layout); } catch (e) {}
        Array.prototype.forEach.call(wrap.querySelectorAll('[data-layout]'), function (x) { x.classList.toggle('active', x === b); });
        refresh();
      });
    });
  }

  // Dense table row per department for the compact list view.
  function renderList(list, origin) {
    var rows = list.map(function (d) {
      var s = d.summary || {};
      var dist = origin ? F.distanceFor(d, origin) : null;
      return '<tr>' +
        '<td class="dl-name"><a href="/departments/' + UI.esc(d.slug) + '/">' + UI.esc(d.name) + '</a>' +
          (s.departmentMaintained ? ' <span class="dc-flag" title="Department maintained" aria-label="Department maintained">◆</span>' : '') + '</td>' +
        '<td class="muted">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + (dist != null ? ' · ' + (Math.round(dist * 10) / 10) + ' mi' : '') + '</td>' +
        '<td class="num">' + (s.hasSalary ? UI.money(s.entry) : '—') + '</td>' +
        '<td class="num">' + (s.hasSalary && s.topBase ? UI.money(s.topBase) : '—') + '</td>' +
        '<td class="num">' + (s.yearsToTop != null && s.yearsToTop > 0 ? s.yearsToTop + ' yr' : '—') + '</td>' +
        '<td>' + (d.scheduleType || '—') + '</td>' +
        '<td>' + (s.confidence ? UI.confidenceChip(s.confidence) : '') + '</td>' +
        '<td class="num"><button class="btn btn-ghost btn-sm add-compare" data-slug="' + UI.esc(d.slug) + '" aria-label="Add ' + UI.esc(d.name) + ' to comparison">' + (CS.has(d.slug) ? '✓ Added' : '＋ Compare') + '</button></td>' +
      '</tr>';
    }).join('');
    return '<div class="table-scroll"><table class="data dir-table"><thead><tr>' +
      '<th scope="col">Department</th><th scope="col">Location</th><th class="num" scope="col">Entry</th>' +
      '<th class="num" scope="col">Top</th><th class="num" scope="col">To top</th><th scope="col">Schedule</th>' +
      '<th scope="col">Data</th><th aria-label="Compare"></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function onChange() { F.syncURL(state); refresh(); }

  function refresh() {
    var origin = F.resolveOrigin(state, allDepts);
    var list = allDepts.filter(F.makePredicate(state, { origin: origin }));
    var q = (state.q || '').toLowerCase();
    if (q) list = list.filter(function (d) { return matchesQuery(d, q); });
    list.sort(F.comparator(state.sort, state.dir, { origin: origin }));

    var count = document.getElementById('result-count');
    if (count) count.textContent = list.length + ' department' + (list.length === 1 ? '' : 's');
    var fc = document.getElementById('filter-count');
    if (fc) { var n = F.activeCount(state); fc.textContent = n ? (n + ' filter' + (n === 1 ? '' : 's')) : ''; }

    var grid = document.getElementById('dept-grid');
    if (!grid) return;
    if (!list.length) {
      grid.className = '';
      grid.innerHTML = '<div class="empty-state">No departments match your search or filters. <button class="btn btn-outline btn-sm" id="reset3">Reset</button></div>';
      var r = document.getElementById('reset3'); if (r) r.onclick = function () { state = F.defaults(); var host = document.getElementById('filter-panel'); if (host) { FU.render(host, state); FU.wire(host, state, onChange); } resetSearchInput(); buildSortUI(); onChange(); };
      return;
    }
    if (layout === 'list') {
      grid.className = '';
      grid.innerHTML = renderList(list, origin);
    } else {
      grid.className = 'grid cols-2';
      grid.innerHTML = list.map(function (d) {
        return UI.deptCard(d, { compareBtn: true, distanceMi: origin ? F.distanceFor(d, origin) : null });
      }).join('');
    }
  }

  function updateTray() {
    var tray = document.getElementById('compare-tray');
    if (!tray) return;
    var n = CS.count();
    tray.style.display = n ? 'flex' : 'none';
    var c = document.getElementById('compare-tray-count'); if (c) c.textContent = n;
  }
})();
