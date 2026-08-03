/*
 * ui.js — Shared render helpers (DOM strings). Keeps markup consistent across
 * the map, directory, compare and department pages. Exposes window.FireUI.
 */
(function () {
  'use strict';
  var Lib = window.FireSalaryLib;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) { return Lib.fmtMoney(v); }
  function hourly(v) { return v == null ? '—' : '$' + (Math.round(v * 100) / 100).toFixed(2) + '/hr'; }

  // Map a confidence key to its chip css class
  var CONF_CLASS = {
    department_maintained: 'dept', strong: 'strong', reported: 'reported',
    conflicting: 'conflicting', needed: 'needed'
  };
  var FRESH_CLASS = {
    current: 'current', update_recommended: 'update', possibly_outdated: 'outdated',
    upcoming: 'upcoming', none: 'needed'
  };

  function confidenceChip(conf) {
    if (!conf) return '';
    return '<span class="chip ' + (CONF_CLASS[conf.key] || 'needed') + '" title="' + esc(conf.description) + '">' +
      '<span class="chip-icon" aria-hidden="true">' + esc(conf.icon) + '</span>' + esc(conf.label) + '</span>';
  }
  function freshnessChip(fresh) {
    if (!fresh) return '';
    return '<span class="chip ' + (FRESH_CLASS[fresh.key] || 'needed') + '" title="' + esc(fresh.description) + '">' +
      '<span class="chip-icon" aria-hidden="true">' + esc(fresh.icon) + '</span>' + esc(fresh.label) + '</span>';
  }
  function deptMaintainedBadge() {
    return '<span class="badge-dept-maintained"><span aria-hidden="true">◆</span> Department maintained</span>';
  }

  function relTime(ms) {
    if (!ms) return 'no date';
    var days = Math.floor((Date.now() - ms) / 86400000);
    if (days < 0) return 'upcoming';
    if (days < 31) return days <= 1 ? 'today' : days + ' days ago';
    var months = Math.round(days / 30.44);
    if (months < 18) return months + ' mo ago';
    var years = Math.round(months / 12 * 10) / 10;
    return years + ' yr ago';
  }

  // Pin status class used by the map + legend (mirrors summary states).
  function pinStatus(dept) {
    var s = dept.summary || {};
    if (!s.hasSalary) return 'missing';
    if (s.departmentMaintained) return 'dept';
    if (s.hasConflict) return 'conflict';
    if (s.freshness && (s.freshness.key === 'possibly_outdated')) return 'outdated';
    if (s.confidence && s.confidence.key === 'strong') return 'strong';
    return 'current';
  }
  var PIN_GLYPH = { current: '●', strong: '▲', outdated: '!', conflict: '◧', dept: '◆', missing: '○' };

  // Directory / list department card
  function deptCard(dept, opts) {
    opts = opts || {};
    var s = dept.summary || {};
    var href = '/departments/' + esc(dept.slug) + '/';
    var incomplete = !s.hasSalary;
    var confKey = (s.confidence && s.confidence.key) || 'needed';

    var distance = (opts.distanceMi != null) ? ' · ' + (Math.round(opts.distanceMi * 10) / 10) + ' mi' : '';
    var sub = esc(shortType(dept.departmentType)) + ' · ' + esc(dept.city) + ', ' + esc(dept.county) + ' County' + distance;
    var flag = s.departmentMaintained
      ? '<span class="dc-flag" title="Department maintained" aria-label="Department maintained">◆</span>' : '';

    var body;
    if (incomplete) {
      body = '<div class="dc-needs"><span class="dc-needs-icon" aria-hidden="true">○</span> Salary not reported yet</div>';
    } else {
      // Secondary stats — only the meaningful ones (skip a "top" that just repeats entry).
      var stats = [];
      if (s.topBase != null && s.topBase !== s.entry) stats.push(statCell(money(s.topBase), 'Top pay'));
      if (s.yearsToTop != null && s.yearsToTop > 0) stats.push(statCell(s.yearsToTop + ' yr', 'To top'));
      if (dept.scheduleType) stats.push(statCell(esc(dept.scheduleType), 'Schedule'));
      if (stats.length < 3 && s.effectiveHourlyEntry != null) stats.push(statCell(hourly(s.effectiveHourlyEntry).replace('/hr', ''), 'Per hour'));
      body = '<div class="dc-pay">' +
        '<div class="dc-entry"><span class="dc-amt">' + money(s.entry) + '</span>' +
          '<span class="dc-amt-lab">Entry firefighter · per year</span></div>' +
        (stats.length ? '<div class="dc-stats">' + stats.slice(0, 3).join('') + '</div>' : '') +
      '</div>';
    }

    var action = incomplete
      ? '<a class="btn btn-primary btn-sm" href="/submit.html?dept=' + esc(dept.slug) + '">Add salary</a>'
      : (opts.compareBtn ? '<button class="btn btn-ghost btn-sm add-compare" data-slug="' + esc(dept.slug) + '">' + ((window.FireCompareStore && window.FireCompareStore.has(dept.slug)) ? '✓ Added' : '＋ Compare') + '</button>' : '');

    return '<article class="card dept-card conf-' + confKey + (incomplete ? ' incomplete' : '') + '">' +
      '<div class="dc-head"><div class="dc-title">' +
        '<h3><a href="' + href + '">' + esc(dept.name) + '</a></h3>' +
        '<div class="dc-sub">' + sub + '</div>' +
      '</div>' + flag + '</div>' +
      body +
      '<div class="dc-foot"><div class="tag-row">' + confidenceChip(s.confidence) + freshnessChip(s.freshness) + '</div>' +
        action +
      '</div>' +
    '</article>';
  }

  function statCell(val, lab) {
    return '<div class="dc-stat"><span class="s-val">' + val + '</span><span class="s-lab">' + esc(lab) + '</span></div>';
  }
  function shortType(t) {
    return ({ municipal: 'Municipal', esd: 'ESD', county: 'County', university: 'University',
      airport: 'Airport', 'fire-rescue-district': 'Fire-Rescue District', combination: 'Combination', other: 'Dept' })[t] || 'Dept';
  }

  window.FireUI = {
    esc: esc, money: money, hourly: hourly, relTime: relTime,
    confidenceChip: confidenceChip, freshnessChip: freshnessChip, deptMaintainedBadge: deptMaintainedBadge,
    deptCard: deptCard, pinStatus: pinStatus, PIN_GLYPH: PIN_GLYPH, shortType: shortType
  };
})();
