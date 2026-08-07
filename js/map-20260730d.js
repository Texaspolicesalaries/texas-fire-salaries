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
  var lastList = [], lastOrigin = null;
  var zipRequestId = 0;
  // Distinguishes a real user drag/scroll/zoom-button click from a move WE
  // triggered programmatically (fitting to results, a ZIP search, "near me").
  // Only the former should narrow the list to the viewport — syncing right
  // after our own fit would compare the list against the exact bounds we just
  // asked Leaflet to fit to, and fitBounds only guarantees that box fits inside
  // the viewport at some discrete zoom level, not that every point on its edge
  // survives a strict contains() check afterward.
  var programmaticMove = false;

  document.addEventListener('DOMContentLoaded', function () {
    state = F.fromURL();
    initMap();
    wireChrome();
    window.FireData.load().then(function () {
      allDepts = window.FireData.all();
      buildFilters();
      onFiltersChanged(true, 'init');
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
    // The side list always mirrors whatever's currently in the map viewport — no
    // manual "search this area" step needed. A filter change still shows/fits
    // every match statewide (see programmaticMove above); only a real pan or
    // zoom narrows the list.
    map.on('moveend', function () {
      if (programmaticMove) { programmaticMove = false; return; }
      syncListToViewport();
    });
  }

  function buildFilters() {
    var host = document.getElementById('filter-panel');
    if (!host) return;
    FU.render(host, state);
    FU.wire(host, state, function (changedKey) {
      if (state.nearLat && state.nearLng) placeMe();
      else clearOriginMarker();
      onFiltersChanged(true, changedKey);
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
    var clearCmp = document.getElementById('compare-clear');
    if (clearCmp) clearCmp.addEventListener('click', function () { CS.clear(); refresh(); });
    CS.onChange(updateCompareTray);
    updateCompareTray();
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.add-compare');
      if (b) { var added = CS.toggle(b.getAttribute('data-slug')); b.textContent = added ? '✓ Added' : '＋ Compare'; }
    });
  }

  function setZipStatus(message, kind) {
    var el = document.getElementById('f-zip-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'zip-status' + (kind ? (' ' + kind) : '');
    if (kind === 'is-success') {
      el.appendChild(document.createTextNode(' · ZIP data by '));
      var source = document.createElement('a');
      source.href = 'https://www.geonames.org/';
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = 'GeoNames';
      el.appendChild(source);
    }
  }

  function onFiltersChanged(fitResults, changedKey) {
    var zip = F.normalizeZip(state.zip);
    var zipInput = document.getElementById('f-zip');
    state.zip = zip;
    if (zipInput && zipInput.value !== zip) zipInput.value = zip;
    if (/^\d{5}$/.test(zip) && !state.radius && (changedKey === 'zip' || changedKey === 'init')) {
      state.radius = '25';
      var radiusInput = document.getElementById('f-radius');
      if (radiusInput) radiusInput.value = '25';
    }
    F.syncURL(state);

    var requestId = ++zipRequestId;
    if (!zip) {
      setZipStatus('');
      refresh(fitResults !== false);
      return;
    }
    if (!/^\d{5}$/.test(zip)) {
      setZipStatus('Enter a 5-digit ZIP code.');
      refresh(fitResults !== false);
      return;
    }

    setZipStatus('Looking up ZIP ' + zip + '…', 'is-loading');
    F.resolveOriginAsync(state, allDepts).then(function (origin) {
      if (requestId !== zipRequestId) return;
      if (!origin) {
        setZipStatus('ZIP code not found. Check it and try again.', 'is-error');
        clearOriginMarker();
      } else {
        var area = [origin.place, origin.state].filter(Boolean).join(', ');
        if (state.radius) {
          setZipStatus('Searching within ' + state.radius + ' miles of ' + (area || zip) + '.', 'is-success');
        } else {
          setZipStatus((area || ('ZIP ' + zip)) + ' selected. Enter a distance in miles to filter.', 'is-success');
        }
        placeOriginMarker([origin.lat, origin.lng], 'ZIP ' + zip + (area ? (' · ' + area) : ''));
        programmaticMove = true;
        map.setView([origin.lat, origin.lng], 9, { animate: false });
      }
      refresh(fitResults !== false && !!state.radius);
    }).catch(function () {
      if (requestId !== zipRequestId) return;
      setZipStatus('ZIP lookup is temporarily unavailable. Please try again.', 'is-error');
      clearOriginMarker();
      refresh(fitResults !== false);
    });
  }

  function refresh(fitResults) {
    if (!allDepts.length) return;
    var origin = F.resolveOrigin(state, allDepts);
    var pred = F.makePredicate(state, { origin: origin });
    var list = allDepts.filter(pred);
    list.sort(F.comparator(state.sort, state.dir, { origin: origin }));
    lastList = list; lastOrigin = origin;
    drawMarkers(list, origin);
    if (fitResults) fitMapToDepartments(list);
    // A refresh (filter change, ZIP search, initial load) always shows every
    // match, statewide if need be. Only a subsequent real pan/zoom (see the
    // moveend handler above) narrows the list down to the current viewport.
    drawList(list, origin);
    var count = document.getElementById('result-count');
    if (count) count.textContent = list.length + ' department' + (list.length === 1 ? '' : 's');
    var fc = document.getElementById('filter-count');
    if (fc) { var n = F.activeCount(state); fc.textContent = n ? (n + ' active') : ''; }
  }

  // Narrows lastList (whatever the filters currently match) down to whatever's
  // in the map viewport right now. A department with no coordinates can never
  // be "in view", so it stays listed regardless of bounds rather than silently
  // disappearing.
  function syncListToViewport() {
    var list = lastList;
    if (map) {
      var b = map.getBounds();
      list = list.filter(function (d) { return typeof d.lat !== 'number' || b.contains([d.lat, d.lng]); });
    }
    drawList(list, lastOrigin);
    var count = document.getElementById('result-count');
    if (count) count.textContent = list.length + ' department' + (list.length === 1 ? '' : 's');
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

  function fitMapToDepartments(list) {
    var points = list.filter(function (d) {
      return typeof d.lat === 'number' && typeof d.lng === 'number';
    }).map(function (d) { return [d.lat, d.lng]; });
    if (!points.length) return;
    programmaticMove = true;
    if (points.length === 1) {
      map.setView(points[0], 10, { animate: false });
      return;
    }
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [36, 36],
      paddingBottomRight: [36, 36],
      maxZoom: 10,
      animate: false
    });
  }

  function popupHTML(d, origin) {
    var s = d.summary || {};
    var dist = origin ? F.distanceFor(d, origin) : null;
    var rows = s.hasSalary ? (
      row('Entry FF', UI.money(s.entry)) +
      row('Top FF', UI.money(s.topBase)) +
      row('Years to top', s.yearsToTop != null ? s.yearsToTop + ' yr' : '—') +
      // Contributor-supplied free text (the described "Other / modified"
      // schedule), so it is escaped before it reaches the popup's innerHTML.
      row('Schedule', UI.esc(d.scheduleType || '—'))
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
    placeOriginMarker(ll, 'Your location');
    programmaticMove = true;
    map.setView(ll, 9);
  }

  function placeOriginMarker(ll, label) {
    if (meMarker) map.removeLayer(meMarker);
    var icon = L.divIcon({
      className: 'your-location-icon',
      html: '<span class="your-location-target" aria-hidden="true"><span></span></span>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -18]
    });
    meMarker = L.marker(ll, { icon: icon, zIndexOffset: 1200 }).addTo(map);
    meMarker.bindPopup(UI.esc(label));
  }

  function clearOriginMarker() {
    if (!meMarker) return;
    map.removeLayer(meMarker);
    meMarker = null;
  }

  function updateCompareTray() {
    var tray = document.getElementById('compare-tray');
    if (!tray) return;
    var n = CS.count();
    tray.style.display = n ? 'flex' : 'none';
    document.body.classList.toggle('has-compare-tray', !!n);
    var label = document.getElementById('compare-tray-count');
    if (label) label.textContent = n;
  }
})();
