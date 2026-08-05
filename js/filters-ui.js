/*
 * filters-ui.js — Builds the shared filter form used by BOTH the map and the
 * directory. Inputs carry data-fkey="<stateKey>"; a generic reader/writer maps
 * DOM <-> the FireFilters state object. Exposes window.FireFiltersUI.
 */
(function () {
  'use strict';
  var UI = window.FireUI;

  var SCHEDULES = ['24/48', '48/96', '24/72', '40-hour'];
  var TYPES = [
    ['municipal', 'Municipal'], ['esd', 'Emergency services district'], ['county', 'County'],
    ['university', 'University'], ['airport', 'Airport'], ['fire-rescue-district', 'Fire-rescue district'],
    ['combination', 'Combination'], ['other', 'Other']
  ];

  function opt(v, label, sel) { return '<option value="' + UI.esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + UI.esc(label) + '</option>'; }
  function selectField(key, label, options, state, placeholder) {
    var opts = '<option value="">' + (placeholder || 'Any') + '</option>' +
      options.map(function (o) { var v = Array.isArray(o) ? o[0] : o; var l = Array.isArray(o) ? o[1] : o; return opt(v, l, state[key]); }).join('');
    return '<div class="field"><label for="f-' + key + '">' + label + '</label><select id="f-' + key + '" data-fkey="' + key + '">' + opts + '</select></div>';
  }
  function numField(key, label, state, hint) {
    return '<div class="field"><label for="f-' + key + '">' + label + '</label>' +
      '<input id="f-' + key + '" data-fkey="' + key + '" type="number" inputmode="numeric" value="' + UI.esc(state[key]) + '" placeholder="' + (hint || '') + '"></div>';
  }
  function check(key, label, state) {
    return '<div class="checkline"><input id="f-' + key + '" data-fkey="' + key + '" type="checkbox"' + (state[key] ? ' checked' : '') + '>' +
      '<label for="f-' + key + '">' + label + '</label></div>';
  }
  function group(title, inner, open) {
    return '<details class="filter-group"' + (open ? ' open' : '') + '><summary>' + title + '</summary><div class="stack" style="margin-top:.5rem">' + inner + '</div></details>';
  }

  function render(container, state) {
    var D = window.FireData;
    // Only list a region once it actually has a department in it — the seed
    // schema defines all 7 Texas regions up front, but showing one that's
    // guaranteed to return zero results is exactly the "selected it, got
    // nothing, no idea why" trap this filter should avoid.
    var regionCounts = {};
    D.all().forEach(function (d) { if (d.region) regionCounts[d.region] = (regionCounts[d.region] || 0) + 1; });
    var regions = D.regions().filter(function (r) { return regionCounts[r.id]; }).map(function (r) { return [r.id, r.name]; });
    var counties = D.counties();
    var cities = D.cities();

    container.innerHTML =
      group('Location',
        selectField('region', 'Region', regions, state) +
        selectField('county', 'County', counties, state) +
        selectField('city', 'City', cities, state) +
        '<div class="filter-row">' +
          '<div class="field"><label for="f-zip">Near ZIP</label><input id="f-zip" data-fkey="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" value="' + UI.esc(state.zip) + '" placeholder="e.g. 75001"></div>' +
          numField('radius', 'Within (mi)', state, '25') +
        '</div>' +
        '<div class="zip-actions">' +
          '<button type="button" class="btn btn-primary btn-sm" id="apply-zip-btn">Search ZIP</button>' +
          '<button type="button" class="btn btn-outline btn-sm" id="near-me-btn">📍 Use my location</button>' +
        '</div>' +
        '<div class="zip-status" id="f-zip-status" aria-live="polite"></div>'
      , true) +
      // Firefighter entry is the one entry figure — paramedic/EMT, certification,
      // education, and longevity pay are add-ons on top of it (see submit.html's
      // supplemental pay section), never a separate "entry" dollar amount.
      group('Compensation',
        numField('entryMin', 'Min entry FF salary', state, '$') +
        numField('topMin', 'Min top FF salary', state, '$') +
        numField('maxYtt', 'Max years to top', state, 'yrs') +
        numField('hourlyMin', 'Min effective hourly', state, '$/hr') +
        check('hasSteps', 'Has complete step plan', state) +
        check('hasMedic', 'Has paramedic incentive', state) +
        check('hasCert', 'Has certification pay', state) +
        check('hasEdu', 'Has education pay', state) +
        check('hasLongevity', 'Has longevity pay', state)
      ) +
      group('Work conditions',
        selectField('schedule', 'Shift schedule', SCHEDULES, state) +
        selectField('type', 'Department type', TYPES, state) +
        selectField('civil', 'Civil service', [['yes', 'Civil service'], ['no', 'Non–civil service']], state)
      ) +
      group('Data quality',
        check('fresh6', 'Updated within 6 months', state) +
        check('fresh12', 'Updated within 12 months', state) +
        check('deptMaint', 'Department maintained', state) +
        check('hasSource', 'Supported by a source', state) +
        check('multiConfirm', 'Confirmed by multiple contributors', state) +
        check('complete', 'Complete salary information', state) +
        check('noDisputed', 'Exclude disputed records', state)
      );
  }

  // DOM -> state
  function read(container, state) {
    container.querySelectorAll('[data-fkey]').forEach(function (el) {
      var k = el.getAttribute('data-fkey');
      if (el.type === 'checkbox') state[k] = el.checked;
      else state[k] = el.value;
    });
    return state;
  }

  // Wire change + the "near me" button. onChange() called after any change.
  function wire(container, state, onChange) {
    container.addEventListener('input', function (event) {
      read(container, state);
      var changedKey = event.target && event.target.getAttribute('data-fkey');
      if (changedKey === 'zip') {
        state.nearLat = '';
        state.nearLng = '';
      }
      onChange(changedKey);
    });
    container.addEventListener('change', function (event) {
      read(container, state);
      onChange(event.target && event.target.getAttribute('data-fkey'));
    });
    var applyZip = container.querySelector('#apply-zip-btn');
    if (applyZip) applyZip.addEventListener('click', function () {
      read(container, state);
      onChange('apply');
    });
    var zipInput = container.querySelector('#f-zip');
    if (zipInput) zipInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      read(container, state);
      onChange('apply');
    });
    var near = container.querySelector('#near-me-btn');
    if (near) near.addEventListener('click', function () {
      if (!navigator.geolocation) { alert('Location is not available in this browser.'); return; }
      near.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        state.zip = '';
        var z = container.querySelector('#f-zip');
        if (z) z.value = '';
        state.nearLat = pos.coords.latitude.toFixed(5);
        state.nearLng = pos.coords.longitude.toFixed(5);
        if (!state.radius) { state.radius = '30'; var r = container.querySelector('#f-radius'); if (r) r.value = '30'; }
        near.textContent = '📍 Location set';
        onChange('near');
      }, function () { near.textContent = '📍 Use my location'; alert('Could not get your location.'); });
    });
  }

  window.FireFiltersUI = { render: render, read: read, wire: wire };
})();
