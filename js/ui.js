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
    var metrics = incomplete ? '' :
      '<div class="dept-metrics">' +
        metric(money(s.entry), 'Entry FF') +
        metric(s.entryMedic ? money(s.entryMedic) : (s.topBase ? money(s.topBase) : '—'), s.entryMedic ? 'FF-Paramedic' : 'Top FF') +
        metric(s.yearsToTop != null ? (s.yearsToTop + ' yr') : '—', 'To top pay') +
      '</div>';
    var distance = (opts.distanceMi != null)
      ? '<span class="pill">' + (Math.round(opts.distanceMi * 10) / 10) + ' mi</span>' : '';
    var cmp = opts.compareBtn
      ? '<button class="btn btn-ghost btn-sm add-compare" data-slug="' + esc(dept.slug) + '">＋ Compare</button>' : '';
    return '' +
    '<article class="card card-hover dept-card' + (incomplete ? ' incomplete' : '') + '">' +
      '<div class="dept-card-head">' +
        '<div>' +
          '<div class="type-tag">' + esc(shortType(dept.departmentType)) + '</div>' +
          '<h3><a href="' + href + '">' + esc(dept.name) + '</a></h3>' +
          '<div class="loc">' + esc(dept.city) + ' · ' + esc(dept.county) + ' County ' + distance + '</div>' +
        '</div>' +
        (s.departmentMaintained ? '<span aria-hidden="true">◆</span>' : '') +
      '</div>' +
      metrics +
      (incomplete ? '<p class="needs-data">Current salary information has not yet been submitted.</p>' : '') +
      '<div class="dept-card-foot">' +
        '<div class="tag-row">' + confidenceChip(s.confidence) + freshnessChip(s.freshness) + '</div>' +
        (incomplete
          ? '<a class="btn btn-primary btn-sm" href="/submit.html?dept=' + esc(dept.slug) + '">Add salary info</a>'
          : cmp) +
      '</div>' +
    '</article>';
  }

  function metric(val, lab) {
    return '<div class="metric"><span class="val">' + val + '</span><span class="lab">' + esc(lab) + '</span></div>';
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
