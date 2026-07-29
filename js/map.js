/*
 * map.js — Interactive Texas map explorer (the central discovery tool).
 * Leaflet + MarkerCluster (loaded from CDN by map.html). Custom status pins,
 * "Search this area", "Near me", popups, a shared filter drawer, and a results
 * list synced to the map. All filter state round-trips through the URL.
 */
(function () {
  'use strict';
  var UI = window.FireUI, F = window.FireFilters, FU = window.FireFiltersUI, CS = window.FireCompareStore;
  var map, cluster, meMarker, state, allDepts = [];
  var restrictToBounds = false;

  document.addEventListener('DOMContentLoaded', function () {
    state = F.fromURL();
    initMap();
    buildFilters();
    wireChrome();
    window.FireData.load().then(function () {
      allDepts = window.FireData.all();
      refresh();
    });
  });

  function initMap() {
    map = L.map('map', { zoomControl: false, scrollWheelZoom: true }).setView([31.3, -99.3], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var url = dark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    L.tileLayer(url, { attribution: '© OpenStreetMap © CARTO', maxZoom: 19, subdomains: 'abcd' }).addTo(map);
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 48,
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        return L.divIcon({ html: '<div class="fire-cluster">' + n + '</div>', className: 'fire-cluster-wrap', iconSize: [40, 40] });
      }
    });
    map.addLayer(cluster);
    map.on('moveend', function () { if (restrictToBounds) refresh(); updateSearchAreaBtn(); });
  }

  function buildFilters() {
    var host = document.getElementById('filter-panel');
    if (!host) return;
    FU.render(host, state);
    FU.wire(host, state, function () {
      if (state.nearLat && state.nearLng) placeMe();
      onFiltersChanged();
    });
  }

  function wireChrome() {
    // Filter drawer open/close (mobile + desktop toggle)
    var openBtn = document.getElementById('open-filters');
    var drawer = document.getElementById('filter-drawer');
    var closeBtn = document.getElementById('close-filters');
    if (openBtn && drawer) openBtn.addEventListener('click', function () { drawer.classList.add('open'); });
    if (closeBtn && drawer) closeBtn.addEventListener('click', function () { drawer.classList.remove('open'); });
    var clearBtn = document.getElementById('clear-filters');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      state = F.defaults(); state.view = 'map';
      buildFilters(); onFiltersChanged();
    });

    // Search-this-area
    var sa = document.getElementById('search-area');
    if (sa) sa.addEventListener('click', function () {
      restrictToBounds = !restrictToBounds;
      sa.setAttribute('aria-pressed', restrictToBounds ? 'true' : 'false');
      sa.textContent = restrictToBounds ? '✓ Searching this area' : '⤢ Search this area';
      refresh();
    });

    // Mobile view toggle
    var explorer = document.querySelector('.explorer');
    document.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-view');
        document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        explorer.classList.toggle('show-map', v === 'map');
        explorer.classList.toggle('show-list', v === 'list');
        if (v === 'map') setTimeout(function () { map.invalidateSize(); }, 50);
      });
    });

    // Compare tray
    CS.onChange(updateCompareTray);
    updateCompareTray();
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.add-compare');
      if (b) { var added = CS.toggle(b.getAttribute('data-slug')); b.textContent = added ? '✓ Added' : '＋ Compare'; }
    });
  }

  function onFiltersChanged() { F.syncURL(state); refresh(); }

  function currentPredicate() {
    var origin = F.resolveOrigin(state, allDepts);
    var base = F.makePredicate(state, { origin: origin });
    if (!restrictToBounds || !map) return { pred: base, origin: origin };
    var b = map.getBounds();
    return {
      origin: origin,
      pred: function (d) { return base(d) && typeof d.lat === 'number' && b.contains([d.lat, d.lng]); }
    };
  }

  function refresh() {
    if (!allDepts.length) return;
    var pc = currentPredicate();
    var list = allDepts.filter(pc.pred);
    list.sort(F.comparator(state.sort, state.dir, { origin: pc.origin }));
    drawMarkers(list, pc.origin);
    drawList(list, pc.origin);
    var count = document.getElementById('result-count');
    if (count) count.textContent = list.length + ' department' + (list.length === 1 ? '' : 's');
    var fc = document.getElementById('filter-count');
    if (fc) { var n = F.activeCount(state); fc.textContent = n ? (n + ' active') : ''; }
  }

  function drawMarkers(list, origin) {
    cluster.clearLayers();
    var markers = [];
    list.forEach(function (d) {
      if (typeof d.lat !== 'number') return;
      var status = UI.pinStatus(d);
      var icon = L.divIcon({
        className: '', iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24],
        html: '<div class="fire-pin pin-' + status + '"><span>' + (UI.PIN_GLYPH[status] || '●') + '</span></div>'
      });
      var m = L.marker([d.lat, d.lng], { icon: icon, title: d.name });
      m.bindPopup(popupHTML(d, origin), { minWidth: 240 });
      markers.push(m);
    });
    cluster.addLayers(markers);
  }

  function popupHTML(d, origin) {
    var s = d.summary || {};
    var dist = origin ? F.distanceFor(d, origin) : null;
    var rows = s.hasSalary ? (
      row('Entry FF', UI.money(s.entry)) +
      (s.entryMedic ? row('FF-Paramedic entry', UI.money(s.entryMedic)) : '') +
      row('Top FF', UI.money(s.topBase)) +
      row('Years to top', s.yearsToTop != null ? s.yearsToTop + ' yr' : '—') +
      row('Schedule', d.scheduleType || '—')
    ) : '<p class="needs-data" style="margin:.3rem 0">Salary information needed.</p>';
    return '<div class="map-popup">' +
      '<strong>' + UI.esc(d.name) + '</strong><div class="muted" style="font-size:.8rem">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + ' Co.' + (dist != null ? ' · ' + (Math.round(dist * 10) / 10) + ' mi' : '') + '</div>' +
      '<div class="tag-row" style="margin:.4rem 0">' + UI.confidenceChip(s.confidence) + UI.freshnessChip(s.freshness) + '</div>' +
      '<table style="width:100%;font-size:.82rem;margin:.2rem 0">' + rows + '</table>' +
      '<div class="muted" style="font-size:.72rem">Updated ' + UI.relTime(s.lastUpdated) + '</div>' +
      '<div style="display:flex;gap:.4rem;margin-top:.5rem">' +
        '<a class="btn btn-primary btn-sm" href="/departments/' + UI.esc(d.slug) + '/">View page</a>' +
        '<button class="btn btn-outline btn-sm add-compare" data-slug="' + UI.esc(d.slug) + '">' + (CS.has(d.slug) ? '✓ Added' : '＋ Compare') + '</button>' +
      '</div></div>';
  }
  function row(k, v) { return '<tr><td class="muted" style="padding:1px 0">' + k + '</td><td style="text-align:right;font-weight:600">' + v + '</td></tr>'; }

  function drawList(list, origin) {
    var body = document.getElementById('list-body');
    if (!body) return;
    if (!list.length) { body.innerHTML = '<div class="empty-state">No departments match these filters.<br><button class="btn btn-outline btn-sm" id="reset2" style="margin-top:1rem">Reset filters</button></div>'; var r = document.getElementById('reset2'); if (r) r.onclick = function () { state = F.defaults(); buildFilters(); onFiltersChanged(); }; return; }
    body.innerHTML = list.map(function (d) {
      var dist = origin ? F.distanceFor(d, origin) : null;
      return UI.deptCard(d, { compareBtn: true, distanceMi: dist });
    }).join('');
  }

  function placeMe() {
    if (!state.nearLat || !state.nearLng) return;
    var ll = [parseFloat(state.nearLat), parseFloat(state.nearLng)];
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.circleMarker(ll, { radius: 8, color: '#2A7268', fillColor: '#2A7268', fillOpacity: .6, weight: 2 }).addTo(map);
    meMarker.bindPopup('Your location');
    map.setView(ll, 9);
  }

  function updateSearchAreaBtn() {
    var sa = document.getElementById('search-area');
    if (sa && !restrictToBounds) sa.textContent = '⤢ Search this area';
  }

  function updateCompareTray() {
    var tray = document.getElementById('compare-tray');
    if (!tray) return;
    var n = CS.count();
    tray.style.display = n ? 'flex' : 'none';
    var label = document.getElementById('compare-tray-count');
    if (label) label.textContent = n;
  }
})();
