/*
 * compare.js — Department comparison (compare.html). Compare up to 10 departments
 * with a shareable URL, base / reported-comp / effective-hourly toggles, and
 * explicit warnings when salaries are NOT directly comparable. Deliberately does
 * NOT produce a single blended ranking across incompatible compensation types.
 */
(function () {
  'use strict';
  var UI = window.FireUI, Lib = window.FireSalaryLib, CS = window.FireCompareStore;
  var mode = 'base'; // base | reported | hourly
  var slugs = [];

  document.addEventListener('DOMContentLoaded', function () {
    window.FireData.load().then(function () {
      slugs = initialSlugs();
      wireModeButtons();
      wireAdder();
      render();
    });
  });

  function initialSlugs() {
    var p = new URLSearchParams(location.search);
    if (p.get('d')) {
      var fromUrl = p.get('d').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, CS.MAX);
      fromUrl.forEach(function (s) { CS.add(s); });
      return fromUrl;
    }
    return CS.list();
  }

  function syncURL() {
    var qs = slugs.length ? ('?d=' + slugs.join(',')) : '';
    history.replaceState(null, '', location.pathname + qs);
  }

  function wireModeButtons() {
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.getAttribute('data-mode');
        document.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
        render();
      });
    });
  }

  function wireAdder() {
    var input = document.getElementById('add-dept');
    var results = document.getElementById('add-results');
    if (!input) return;
    input.addEventListener('input', function () {
      var q = input.value.trim();
      var list = q ? window.FireData.search(q).filter(function (d) { return slugs.indexOf(d.slug) === -1; }) : [];
      results.innerHTML = list.map(function (d) { return '<a href="#" data-slug="' + UI.esc(d.slug) + '"><span>' + UI.esc(d.name) + '</span><span class="r-loc">' + UI.esc(d.city) + '</span></a>'; }).join('');
      results.classList.toggle('open', list.length > 0);
    });
    results.addEventListener('click', function (e) {
      var a = e.target.closest('a'); if (!a) return; e.preventDefault();
      var slug = a.getAttribute('data-slug');
      if (slugs.length >= CS.MAX) { alert('You can compare up to ' + CS.MAX + ' departments.'); return; }
      if (slugs.indexOf(slug) === -1) { slugs.push(slug); CS.add(slug); }
      input.value = ''; results.classList.remove('open'); results.innerHTML = '';
      render();
    });
  }

  function remove(slug) { slugs = slugs.filter(function (s) { return s !== slug; }); CS.remove(slug); render(); }

  function render() {
    syncURL();
    var wrap = document.getElementById('compare-wrap');
    var depts = slugs.map(function (s) { return window.FireData.get(s); }).filter(Boolean);
    if (!depts.length) {
      wrap.innerHTML = '<div class="empty-state">No departments selected yet. Use the search above, or add departments from the <a href="/map.html">map</a> or <a href="/departments.html">directory</a>.</div>';
      return;
    }
    wrap.innerHTML = warningsHTML(depts) + tableHTML(depts);
    wrap.querySelectorAll('.remove-col').forEach(function (b) { b.addEventListener('click', function () { remove(b.getAttribute('data-slug')); }); });
    markScrollable(wrap);
  }

  // The "swipe to see more" hint only makes sense when the table genuinely
  // overflows its container — on a wide screen with two departments it doesn't,
  // and a permanent hint would just be noise. Re-checked on resize since the
  // same table can cross the threshold when the window changes.
  function markScrollable(wrap) {
    var ts = wrap.querySelector('.table-scroll');
    if (!ts) return;
    var check = function () { ts.classList.toggle('is-scrollable', ts.scrollWidth > ts.clientWidth + 1); };
    check();
    if (!markScrollable._wired) { markScrollable._wired = true; window.addEventListener('resize', function () { var el = document.querySelector('#compare-wrap .table-scroll'); if (el) el.classList.toggle('is-scrollable', el.scrollWidth > el.clientWidth + 1); }); }
  }

  // ---- Comparability warnings (never hide incompatibility) ----
  function warningsHTML(depts) {
    var withSalary = depts.filter(function (d) { return d.summary.hasSalary; });
    var warns = [];
    var otSet = uniqBool(withSalary.map(function (d) { return d.summary.includesScheduledOvertime; }));
    if (otSet.length > 1) warns.push('One or more departments report annual compensation that <strong>includes scheduled overtime</strong>, while others report base pay only. Compare base salary and annual hours before comparing totals.');
    var medicSet = uniqBool(withSalary.map(function (d) { return !!(d.flags && d.flags.paramedicRequired); }));
    if (medicSet.length > 1) warns.push('Some departments require <strong>paramedic</strong> certification while others use EMT-level classifications. Entry pay may not represent the same role.');
    var years = uniq(withSalary.map(function (d) { return (d.summary.effectiveDate || '').slice(0, 4); }).filter(Boolean));
    if (years.length > 1) warns.push('Figures come from different effective years (' + years.sort().join(', ') + ').');
    if (withSalary.some(function (d) { return d.summary.hasConflict; })) warns.push('At least one department has <strong>conflicting</strong> community reports — its displayed value is contested.');
    var ages = withSalary.map(function (d) { return d.summary.lastUpdated; }).filter(Boolean);
    if (ages.length > 1 && (Math.max.apply(null, ages) - Math.min.apply(null, ages)) > 365 * 24 * 3600 * 1000) warns.push('One record is materially older than another (more than a year apart). Freshness varies — see the freshness row.');
    if (!warns.length) return '';
    return '<div class="notice warn" style="margin-bottom:1rem"><span class="notice-icon" aria-hidden="true">⚠</span><div><strong>Not always directly comparable.</strong><ul style="margin:.4rem 0 0;padding-left:1.1rem">' +
      warns.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul></div></div>';
  }

  function tableHTML(depts) {
    var cols = depts.map(function (d) {
      return '<th class="dept-col" scope="col"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:start">' +
        '<a href="/departments/' + UI.esc(d.slug) + '/">' + UI.esc(d.name) + '</a>' +
        '<button class="btn btn-ghost btn-sm remove-col" data-slug="' + UI.esc(d.slug) + '" aria-label="Remove ' + UI.esc(d.name) + '">✕</button></div>' +
        '<div class="muted" style="font-weight:400;font-size:.8rem">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + ' Co.</div></th>';
    }).join('');

    var rows = '';
    rows += salaryRow('Entry firefighter pay', depts, function (s) { return entryVal(s); });
    rows += salaryRow('Midpoint pay', depts, function (s) { return midpointVal(s); });
    rows += salaryRow('Top firefighter pay', depts, function (s) { return topVal(s); });
    rows += plainRow('Years to top', depts, function (s) { return s.yearsToTop != null ? s.yearsToTop + ' yr' : '—'; });
    rows += plainRow('Annual scheduled hours', depts, function (s) { return s.annualHours ? s.annualHours.toLocaleString() : '—'; });
    rows += plainRow('Effective hourly (entry)', depts, function (s) { return UI.hourly(s.effectiveHourlyEntry); });
    rows += careerRow('5-year career earnings', depts, 5);
    rows += careerRow('10-year career earnings', depts, 10);
    rows += careerRow('20-year career earnings', depts, 20);
    rows += plainRowD('Shift schedule', depts, function (d) { return d.scheduleType || '—'; });
    rows += flagRow('Paramedic incentive', depts, 'paramedicIncentive');
    rows += flagRow('Certification pay', depts, 'certPay');
    rows += flagRow('Education pay', depts, 'educationPay');
    rows += flagRow('Longevity pay', depts, 'longevity');
    rows += chipRow('Data freshness', depts, function (s) { return UI.freshnessChip(s.freshness); });
    rows += chipRow('Community confidence', depts, function (s) { return UI.confidenceChip(s.confidence); });
    rows += plainRow('Contributors', depts, function (s) { return s.contributors || 0; });

    return '<div class="table-scroll"><table class="data compare-table"><thead><tr><th scope="col" class="row-label">Metric</th>' + cols + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="scroll-hint" aria-hidden="true">← Swipe the table to see more departments →</p>' +
      '<p class="muted" style="font-size:.82rem;margin-top:.75rem">Career earnings assume the step in effect at the start of each service year; where a plan\'s final step is bounded, the final submitted step is carried forward. Base and reported-total figures are kept separate — switch the metric toggle to compare like with like.</p>';
  }

  // ---- Row builders ----
  function entryVal(s) { if (!s.hasSalary) return '—'; if (mode === 'hourly') return UI.hourly(s.effectiveHourlyEntry); return fmtByMode(mode === 'reported' ? s.reportedEntry : s.entry, s); }
  function midpointVal(s) { if (!s.hasSalary) return '—'; if (mode === 'hourly') return UI.hourly(s.effectiveHourlyMidpoint); return fmtByMode(mode === 'reported' ? s.reportedMidpoint : s.midpoint, s); }
  function topVal(s) { if (!s.hasSalary) return '—'; if (mode === 'hourly') return UI.hourly(s.effectiveHourlyTop); return fmtByMode(mode === 'reported' ? s.reportedTop : s.topBase, s); }
  function fmtByMode(v, s) { return v == null ? '—' : UI.money(v); }

  function salaryRow(label, depts, fn) {
    var best = bestNumeric(depts.map(function (d) { return d.summary.hasSalary ? numFromCell(fn(d.summary)) : null; }));
    return '<tr><th scope="row" class="row-label">' + label + '</th>' + depts.map(function (d) {
      var cell = d.summary.hasSalary ? fn(d.summary) : '—';
      var v = numFromCell(cell);
      var hi = (best != null && v === best && depts.length > 1) ? ' style="color:var(--accent);font-weight:700"' : '';
      return '<td class="num"' + hi + '>' + cell + '</td>';
    }).join('') + '</tr>';
  }
  function careerRow(label, depts, years) {
    var vals = depts.map(function (d) {
      var s = d.summary; if (!s.hasSalary || !s.steps) return null;
      var field = mode === 'reported' ? 'reportedAnnualCompensation' : 'baseAnnualSalary';
      var steps = Lib.stepsForField(s.steps, field);
      var r = Lib.projectEarnings(steps, years);
      return r.total;
    });
    var best = bestNumeric(vals);
    return '<tr><th scope="row" class="row-label">' + label + (mode === 'reported' ? ' (reported)' : ' (base)') + '</th>' +
      depts.map(function (d, i) {
        var v = vals[i];
        var hi = (best != null && v === best && depts.length > 1) ? ' style="color:var(--accent);font-weight:700"' : '';
        return '<td class="num"' + hi + '>' + (v == null ? '—' : UI.money(v)) + '</td>';
      }).join('') + '</tr>';
  }
  function plainRow(label, depts, fn) {
    return '<tr><th scope="row" class="row-label">' + label + '</th>' + depts.map(function (d) { return '<td class="num">' + (d.summary.hasSalary ? fn(d.summary) : '—') + '</td>'; }).join('') + '</tr>';
  }
  // All data cells share the same class="num" (right-aligned) treatment as
  // salaryRow/plainRow/careerRow above — mixing left- and right-aligned rows
  // in the same column made it hard to scan a department's values straight
  // down the column.
  function plainRowD(label, depts, fn) {
    return '<tr><th scope="row" class="row-label">' + label + '</th>' + depts.map(function (d) { return '<td class="num">' + fn(d) + '</td>'; }).join('') + '</tr>';
  }
  function flagRow(label, depts, key) {
    return '<tr><th scope="row" class="row-label">' + label + '</th>' + depts.map(function (d) { var on = d.flags && d.flags[key]; return '<td class="num">' + (on ? '<span aria-label="yes">✓</span>' : '<span class="faint" aria-label="no">—</span>') + '</td>'; }).join('') + '</tr>';
  }
  function chipRow(label, depts, fn) {
    return '<tr><th scope="row" class="row-label">' + label + '</th>' + depts.map(function (d) { return '<td class="num">' + (d.summary.hasSalary || fn(d.summary) ? fn(d.summary) : '—') + '</td>'; }).join('') + '</tr>';
  }

  function numFromCell(cell) { if (typeof cell === 'number') return cell; var n = parseFloat(String(cell).replace(/[$,\/hryr\s]/g, '')); return isFinite(n) ? n : null; }
  function bestNumeric(arr) { var nums = arr.filter(function (v) { return typeof v === 'number' && isFinite(v); }); return nums.length ? Math.max.apply(null, nums) : null; }
  function uniq(a) { var s = {}; a.forEach(function (v) { s[v] = true; }); return Object.keys(s); }
  function uniqBool(a) { var s = {}; a.forEach(function (v) { s[v ? '1' : '0'] = true; }); return Object.keys(s); }
})();
