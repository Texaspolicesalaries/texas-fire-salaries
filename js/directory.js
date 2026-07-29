/*
 * directory.js — Department directory (departments.html). List-only view sharing
 * the same filter engine + cards as the map. Sort toolbar, result count, filter
 * drawer, URL-synced state, "needs data" surfacing.
 */
(function () {
  'use strict';
  var UI = window.FireUI, F = window.FireFilters, FU = window.FireFiltersUI, CS = window.FireCompareStore;
  var state, allDepts = [];

  var SORTS = [
    ['name', 'Department name'], ['entry', 'Entry pay'], ['medic', 'Paramedic pay'],
    ['top', 'Top pay'], ['ytt', 'Years to top'], ['hourly', 'Effective hourly'],
    ['distance', 'Distance'], ['updated', 'Most recently updated'], ['confirmations', 'Most confirmations']
  ];

  document.addEventListener('DOMContentLoaded', function () {
    state = F.fromURL();
    buildSortUI();
    wireChrome();
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
      buildSortUI(); onChange();
    });
    CS.onChange(updateTray); updateTray();
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.add-compare');
      if (b) { var added = CS.toggle(b.getAttribute('data-slug')); b.textContent = added ? '✓ Added' : '＋ Compare'; }
    });
  }

  function onChange() { F.syncURL(state); refresh(); }

  function refresh() {
    var origin = F.resolveOrigin(state, allDepts);
    var list = allDepts.filter(F.makePredicate(state, { origin: origin }));
    list.sort(F.comparator(state.sort, state.dir, { origin: origin }));

    var count = document.getElementById('result-count');
    if (count) count.textContent = list.length + ' department' + (list.length === 1 ? '' : 's');
    var fc = document.getElementById('filter-count');
    if (fc) { var n = F.activeCount(state); fc.textContent = n ? (n + ' filter' + (n === 1 ? '' : 's')) : ''; }

    var grid = document.getElementById('dept-grid');
    if (!grid) return;
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No departments match your filters. <button class="btn btn-outline btn-sm" id="reset3">Reset</button></div>';
      var r = document.getElementById('reset3'); if (r) r.onclick = function () { state = F.defaults(); var host = document.getElementById('filter-panel'); if (host) { FU.render(host, state); FU.wire(host, state, onChange); } buildSortUI(); onChange(); };
      return;
    }
    grid.innerHTML = list.map(function (d) {
      return UI.deptCard(d, { compareBtn: true, distanceMi: origin ? F.distanceFor(d, origin) : null });
    }).join('');
  }

  function updateTray() {
    var tray = document.getElementById('compare-tray');
    if (!tray) return;
    var n = CS.count();
    tray.style.display = n ? 'flex' : 'none';
    var c = document.getElementById('compare-tray-count'); if (c) c.textContent = n;
  }
})();
