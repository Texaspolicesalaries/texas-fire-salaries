/*
 * directory.js — Department directory (departments.html). List-only view sharing
 * the same filter engine + cards as the map. Sort toolbar, result count, filter
 * drawer, URL-synced state, "needs data" surfacing.
 */
(function () {
  'use strict';
  var UI = window.FireUI, F = window.FireFilters, FU = window.FireFiltersUI, CS = window.FireCompareStore;
  var state, allDepts = [];
  // How many results are rendered at once. Reset to one page on any change to
  // the result set (filter, search, sort) so a fresh query starts at the top.
  var PAGE_SIZE = 24;
  var shown = PAGE_SIZE;
  // Card grid vs. compact list — remembered across visits.
  var layout = 'cards';
  try { layout = localStorage.getItem('fireDirLayout') || 'cards'; } catch (e) {}

  var SORTS = [
    ['name', 'Alphabetical (A–Z)'], ['entry', 'Entry pay'],
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
      sel.addEventListener('change', function () {
        state.sort = sel.value;
        // "Most recently updated" and "Most confirmations" name their own
        // direction, so picking one has to set it — otherwise the list opens on
        // the oldest and least-confirmed departments, the exact opposite of the
        // label. Other sorts keep whichever direction is already showing.
        if (F.defaultDirFor && F.defaultDirFor(state.sort) === 'desc') state.dir = 'desc';
        var dirBtn = document.getElementById('sort-dir');
        if (dirBtn) setDirLabel(dirBtn);
        onChange();
      });
    }
    var dir = document.getElementById('sort-dir');
    if (dir) {
      setDirLabel(dir);
      dir.addEventListener('click', function () { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; setDirLabel(dir); onChange(); });
    }
  }
  // The direction wording follows the sort: an alphabetical list reads A→Z /
  // Z→A, while every numeric sort reads Low→High / High→Low.
  function setDirLabel(btn) {
    var alpha = state.sort === 'name';
    btn.textContent = state.dir === 'desc'
      ? (alpha ? '↓ Z→A' : '↓ High→Low')
      : (alpha ? '↑ A→Z' : '↑ Low→High');
  }

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
    var clearCmp = document.getElementById('compare-clear');
    if (clearCmp) clearCmp.addEventListener('click', function () { CS.clear(); refresh(); });
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
    var searchTrackTimer = null;
    input.addEventListener('input', function () {
      state.q = input.value.trim(); toggleClear(); onChange();
      clearTimeout(searchTrackTimer);
      if (state.q && window.FireAnalytics) {
        var q = state.q;
        searchTrackTimer = setTimeout(function () {
          var count = document.getElementById('result-count');
          window.FireAnalytics.trackSearch('directory', q, count ? parseInt(count.textContent, 10) : undefined);
        }, 600);
      }
    });
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
        // Contributor-supplied free text since the form began accepting a
        // described "Other / modified" schedule — never interpolate it raw.
        '<td>' + UI.esc(d.scheduleType || '—') + '</td>' +
        '<td>' + (s.confidence ? UI.confidenceChip(s.confidence) : '') + '</td>' +
        '<td class="num"><button class="btn btn-ghost btn-sm add-compare" data-slug="' + UI.esc(d.slug) + '" aria-label="Add ' + UI.esc(d.name) + ' to comparison">' + (CS.has(d.slug) ? '✓ Added' : '＋ Compare') + '</button></td>' +
      '</tr>';
    }).join('');
    return '<div class="table-scroll"><table class="data dir-table"><thead><tr>' +
      '<th scope="col">Department</th><th scope="col">Location</th><th class="num" scope="col">Entry</th>' +
      '<th class="num" scope="col">Top</th><th class="num" scope="col">To top</th><th scope="col">Schedule</th>' +
      '<th scope="col">Data</th><th aria-label="Compare"></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function onChange() { shown = PAGE_SIZE; F.syncURL(state); refresh(); }

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
      // A text search that comes up empty is usually a real department that
      // just isn't in the database yet (coverage is still growing region by
      // region), not a typo — point at submitting it, not just resetting.
      var searchNote = state.q
        ? '<p><strong>' + UI.esc(state.q) + '</strong> didn\'t match anything — it may not be in the database yet.</p><a class="btn btn-primary btn-sm" href="/submit.html?mode=add">Submit this department →</a> '
        : '<p>No departments match your current filters.</p>';
      grid.innerHTML = '<div class="empty-state">' + searchNote + '<button class="btn btn-outline btn-sm" id="reset3">Reset filters</button></div>';
      var r = document.getElementById('reset3'); if (r) r.onclick = function () { state = F.defaults(); var host = document.getElementById('filter-panel'); if (host) { FU.render(host, state); FU.wire(host, state, onChange); } resetSearchInput(); buildSortUI(); onChange(); };
      return;
    }
    // Render a page at a time. At 54 departments the full list is already a
    // ~4,200px scroll on a phone, and it grows with every region added — so
    // cap the initial render and let the reader ask for more. `shown` resets
    // whenever the result set changes (see onChange) so a new search always
    // starts from the top of its own list.
    var slice = list.slice(0, shown);
    var remaining = list.length - slice.length;

    if (layout === 'list') {
      grid.className = '';
      grid.innerHTML = renderList(slice, origin);
    } else {
      grid.className = 'grid cols-2';
      grid.innerHTML = slice.map(function (d) {
        return UI.deptCard(d, { compareBtn: true, distanceMi: origin ? F.distanceFor(d, origin) : null });
      }).join('');
    }

    var more = document.getElementById('load-more-wrap');
    if (more) {
      more.innerHTML = remaining > 0
        ? '<button class="btn btn-outline" id="load-more">Show ' + Math.min(PAGE_SIZE, remaining) +
          ' more <span class="faint">(' + remaining + ' remaining)</span></button>'
        : '';
      var btn = document.getElementById('load-more');
      if (btn) btn.onclick = function () {
        shown += PAGE_SIZE;
        refresh();
        // Keep the reader where they were rather than jumping; focus the new
        // button so keyboard users don't lose their place in the list.
        var next = document.getElementById('load-more');
        if (next) next.focus();
      };
    }
  }

  function updateTray() {
    var tray = document.getElementById('compare-tray');
    if (!tray) return;
    var n = CS.count();
    tray.style.display = n ? 'flex' : 'none';
    // Reserve room at the bottom of the page while the floating tray is up,
    // otherwise it sits permanently on top of the last row of results.
    document.body.classList.toggle('has-compare-tray', !!n);
    var c = document.getElementById('compare-tray-count'); if (c) c.textContent = n;
  }
})();
