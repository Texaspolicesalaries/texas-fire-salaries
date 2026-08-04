/*
 * submit.js — Guided submission wizard (submit.html).
 *
 * Four steps: (1) Department & type, (2) Compensation, (3) Source, (4) Review.
 * Step 2 has two mutually-exclusive modes:
 *   • Single pay figure — one structured amount (position, career point, period,
 *     basis, effective date, schedule, hours) + supplemental pay.
 *   • Full step pay plan — plan-level fields + a state-backed step editor
 *     (grid on desktop, stacked cards on mobile) storing one record per step
 *     {label,startMonths,basePay,scheduledOvertime,isTopStep} with live derived
 *     values (entry/top/years-to-top/entry→top %/effective hourly).
 * Plan mode never emits a duplicate single-pay figure; entry/top for the consensus
 * engine are derived from the steps. Review shows an old→new diff. Backward compatible
 * with existing single-pay submissions and seed step plans.
 */
(function () {
  'use strict';
  var UI = window.FireUI, Lib = window.FireSalaryLib, D = window.FireData, A = window.FireAuth;

  var POSITIONS = ['Recruit', 'Firefighter'];
  var PERIODS = [['annual', 'Per year'], ['monthly', 'Per month'], ['hourly', 'Per hour']];
  var PLAN_PERIODS = [['annual', 'Per year'], ['hourly', 'Per hour']];
  var BASIS = [['base', 'Base pay only'], ['base-ot', 'Base + scheduled overtime'], ['total', 'Reported total compensation']];
  var UNITS = [['yr', '$/yr'], ['mo', '$/mo'], ['hr', '$/hr'], ['pct', '% of base']];
  var SCHEDULES = [['', '—'], '24/48', '48/96', '24/72', '40-hour'];
  var SUPP_TYPES = [
    ['emt', 'EMT certification'], ['paramedic-incentive', 'Paramedic incentive (on top of base)'],
    ['tcfp-basic', 'TCFP Basic'], ['tcfp-intermediate', 'TCFP Intermediate'], ['tcfp-advanced', 'TCFP Advanced'], ['tcfp-master', 'TCFP Master'],
    ['edu-hs', 'Education — HS diploma'], ['edu-associate', 'Education — Associate'], ['edu-bachelor', 'Education — Bachelor’s'], ['edu-master', 'Education — Master’s'],
    ['bilingual', 'Bilingual pay'], ['longevity', 'Longevity pay'], ['driver-engineer', 'Driver/Engineer pay'], ['rank', 'Officer / rank pay'],
    ['assignment', 'Assignment / specialty pay'], ['holiday', 'Holiday pay'], ['certification', 'Certification pay (other)'],
    ['stipend', 'Stipend (uniform, phone, etc.)'], ['bonus', 'Hiring / retention bonus'], ['other', 'Other']
  ];
  var PROVENANCE = [
    ['official-pay-plan', 'Official pay plan / salary schedule'], ['department-website', 'Department or city website'],
    ['cba', 'Collective bargaining agreement / meet-and-confer'], ['recruiting-flyer', 'Recruiting flyer or posting'],
    ['personal', 'I work / worked here'], ['community', 'Community knowledge']
  ];
  var SOURCED_PROVENANCE = { 'official-pay-plan': 1, 'department-website': 1, 'cba': 1, 'recruiting-flyer': 1 };

  var st = { type: 'update', step: 1, dept: '', mode: 'single', steps: [] };
  var totalSteps = 4;
  var _sid = 0;

  document.addEventListener('DOMContentLoaded', function () {
    D.load().then(function () {
      var p = new URLSearchParams(location.search);
      if (p.get('mode') === 'add') st.type = 'add';
      if (p.get('mode') === 'step') st.mode = 'plan';
      st.dept = p.get('dept') || '';
      renderGate();
      render();
    });
    if (A) A.onChange(renderGate);
  });

  // ── Auth gate ───────────────────────────────────────────────────────────────
  function renderGate() {
    var g = document.getElementById('submit-gate');
    if (!g) return;
    if (A && A.canContribute()) { g.classList.remove('show'); return; }
    g.classList.add('show');
    if (!window.FireDB || !window.FireDB.configured) {
      g.innerHTML = '<span aria-hidden="true">🔎</span><div><strong>Preview mode.</strong> Firebase isn’t connected in this build, so submissions are validated and summarized but not saved. You can still walk through every step.</div>';
    } else if (A && A.isSignedIn() && !A.isVerified()) {
      g.innerHTML = '<span aria-hidden="true">📧</span><div>Please verify your email before publishing. <button class="btn btn-outline btn-sm" id="resend">Resend verification</button></div>';
      var r = document.getElementById('resend'); if (r) r.onclick = function () { A.sendVerification().then(function () { r.textContent = 'Sent'; }); };
    } else {
      g.innerHTML = '<span aria-hidden="true">🔒</span><div>Sign in with a verified email to publish. <a href="/sign-in.html">Sign in →</a></div>';
    }
  }

  // ── Field helpers ─────────────────────────────────────────────────────────────
  function field(label, control, hint, forId) {
    return '<div class="field"><label' + (forId ? ' for="' + forId + '"' : '') + '>' + label + '</label>' + control + (hint ? '<div class="field-hint">' + hint + '</div>' : '') + '</div>';
  }
  function txt(id, ph, val) { return '<input id="' + id + '" type="text" placeholder="' + (ph || '') + '" value="' + (val != null ? UI.esc(val) : '') + '">'; }
  function money(id, ph) { return '<input id="' + id + '" type="text" inputmode="decimal" class="money" placeholder="' + (ph || '$') + '">'; }
  function numI(id, ph) { return '<input id="' + id + '" type="text" inputmode="numeric" placeholder="' + (ph || '') + '">'; }
  function dateI(id) { return '<input id="' + id + '" type="date">'; }
  // Display-only: "2026-01-15" -> "01/15/2026". Non-ISO/legacy values pass through unchanged.
  function fmtDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? (m[2] + '/' + m[3] + '/' + m[1]) : (iso || null); }
  function sel(id, opts, selVal) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      var val = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + UI.esc(val) + '"' + (selVal === val ? ' selected' : '') + '>' + UI.esc(l) + '</option>';
    }).join('') + '</select>';
  }
  function selP(id, opts, ph) {
    return '<select id="' + id + '"><option value="">' + (ph || 'Select…') + '</option>' +
      opts.map(function (o) { var val = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + UI.esc(val) + '">' + UI.esc(l) + '</option>'; }).join('') + '</select>';
  }
  function v(id) { var el = document.getElementById(id); return el ? String(el.value).trim() : ''; }
  function commaFmt(el) { var d = el.value.replace(/[^\d.]/g, ''); var n = parseFloat(d); el.value = isFinite(n) ? n.toLocaleString('en-US') : (d ? el.value.replace(/[^\d.]/g, '') : ''); }

  // ── Wizard shell ──────────────────────────────────────────────────────────────
  var STEP_LABELS = ['Department', 'Compensation', 'Source', 'Review'];
  function indicator() {
    return '<div class="wiz-steps">' + STEP_LABELS.map(function (lab, i) {
      var n = i + 1, cls = n === st.step ? 'active' : (n < st.step ? 'done' : '');
      return '<div class="wiz-step ' + cls + '"' + (n === st.step ? ' aria-current="step"' : '') + '><span class="dot">' + (n < st.step ? '✓' : n) + '</span><span class="lab">' + lab + '</span></div>';
    }).join('<span class="wiz-sep"></span>') + '</div>';
  }

  function render() {
    var host = document.getElementById('submit-body');
    if (!host) return;
    host.innerHTML =
      '<div id="wiz-indicator"></div>' +
      '<form id="the-form" novalidate onsubmit="return false">' +
        '<div class="wiz-panel" data-step="1">' + step1() + '</div>' +
        '<div class="wiz-panel" data-step="2">' + step2() + '</div>' +
        '<div class="wiz-panel" data-step="3">' + step3() + '</div>' +
        '<div class="wiz-panel" data-step="4" id="panel-review"></div>' +
      '</form>' +
      '<div id="wiz-nav-c"></div>' +
      '<div id="form-status" role="alert" aria-live="assertive" style="margin-top:1rem"></div>';
    wireStep();
    updateChrome();
  }

  function updateChrome() {
    var ind = document.getElementById('wiz-indicator'); if (ind) ind.innerHTML = indicator();
    var navc = document.getElementById('wiz-nav-c'); if (navc) navc.innerHTML = nav();
    document.querySelectorAll('.wiz-panel').forEach(function (p) { p.style.display = (parseInt(p.getAttribute('data-step'), 10) === st.step) ? '' : 'none'; });
    if (st.step === 4) { var rp = document.getElementById('panel-review'); if (rp) rp.innerHTML = step4(); }
    wireNav();
  }

  function goStep(n) {
    st.step = n;
    var s = document.getElementById('form-status'); if (s) s.innerHTML = '';
    updateChrome();
    var top = document.querySelector('main'); if (top) window.scrollTo({ top: top.offsetTop, behavior: 'smooth' });
  }
  function wireNav() {
    var back = document.getElementById('wiz-back'); if (back) back.onclick = function () { goStep(st.step - 1); };
    var next = document.getElementById('wiz-next'); if (next) next.onclick = function () { if (validateStep()) goStep(st.step + 1); };
    var submit = document.getElementById('wiz-submit'); if (submit) submit.onclick = onSubmit;
  }
  function nav() {
    var back = st.step > 1 ? '<button class="btn btn-outline" id="wiz-back">← Back</button>' : '<span></span>';
    var next = st.step < totalSteps
      ? '<button class="btn btn-primary" id="wiz-next">Continue →</button>'
      : '<button class="btn btn-primary btn-lg" id="wiz-submit">Submit for the community</button>';
    return '<div class="wiz-nav">' + back + next + '</div>';
  }

  // ── Step 1 ─────────────────────────────────────────────────────────────────────
  function step1() {
    var typeToggle =
      '<div class="seg" id="type-seg" role="group" aria-label="Submission type">' +
        '<button type="button" data-type="update" class="' + (st.type === 'update' ? 'active' : '') + '">Update a department</button>' +
        '<button type="button" data-type="add" class="' + (st.type === 'add' ? 'active' : '') + '">Add a new department</button>' +
      '</div>';
    if (st.type === 'add') {
      return '<h2>Add a department</h2>' + typeToggle +
        '<p class="muted">Add a Texas fire department that isn’t listed yet.</p>' +
        '<div class="grid cols-2">' + field('Department name', txt('f-name', 'e.g. Sample Fire Department'), null, 'f-name') + field('City', txt('f-city'), null, 'f-city') + '</div>' +
        '<div class="grid cols-3">' +
          field('County *', txt('f-county'), null, 'f-county') +
          field('ZIP *', '<input id="f-zip" type="text" inputmode="numeric" maxlength="5">', 'Required — this is how we place the department on the map.', 'f-zip') +
          field('Type', sel('f-dtype', [['municipal', 'Municipal'], ['esd', 'Emergency services district'], ['county', 'County'], ['university', 'University'], ['airport', 'Airport'], ['fire-rescue-district', 'Fire-rescue district'], ['combination', 'Combination'], ['other', 'Other']]), null, 'f-dtype') + '</div>' +
        field('Website or careers URL', '<input id="f-web" type="url" placeholder="https://">', null, 'f-web');
    }
    return '<h2>Which department?</h2>' + typeToggle +
      field('Search for a department',
        '<input id="f-dept-search" type="text" list="dept-list" autocomplete="off" placeholder="Type a department, city, or county…">' +
        '<datalist id="dept-list">' + D.all().map(function (d) { return '<option value="' + UI.esc(d.name + ' — ' + d.city) + '"></option>'; }).join('') + '</datalist>',
        'Start typing — 54 departments listed.', 'f-dept-search') +
      '<div id="current-values"></div>';
  }

  function currentValuesCard(dept) {
    var s = dept.summary || {};
    if (!s.hasSalary) return '<div class="notice info" style="margin-top:.5rem"><span class="notice-icon">ℹ</span><div><strong>' + UI.esc(dept.name) + '</strong> has no salary on file yet — anything you add will be its first report.</div></div>';
    var row = function (k, val) { return '<div class="cv-row"><span>' + k + '</span><strong>' + val + '</strong></div>'; };
    return '<div class="card card-tight cv-card" style="margin-top:.75rem"><div class="cv-title">Current values for ' + UI.esc(dept.name) + '</div>' +
      row('Entry pay', UI.money(s.entry)) + row('Top pay', s.topBase ? UI.money(s.topBase) : '—') +
      row('Years to top', s.yearsToTop != null ? s.yearsToTop + ' yr' : '—') + row('Schedule', dept.scheduleType || '—') +
      row('Effective date', fmtDate(dept.salary && dept.salary.effectiveDate) || '—') +
      '<p class="field-hint" style="margin:.5rem 0 0">Only fill in what you’re changing on the next step.</p></div>';
  }

  // ── Step 2 ─────────────────────────────────────────────────────────────────────
  function step2() {
    var intro = st.type === 'add'
      ? '<h2>Compensation (optional)</h2><p class="muted">Add starting pay for ' + UI.esc(deptName()) + ' now, or skip and let the community fill it in.</p>'
      : '<h2>What are you changing?</h2><p class="muted">For ' + UI.esc(deptName()) + '.</p>';
    var modeSeg =
      '<div class="seg" id="mode-seg" role="group" aria-label="Compensation mode">' +
        '<button type="button" data-mode="single" class="' + (st.mode === 'single' ? 'active' : '') + '">Single pay figure</button>' +
        '<button type="button" data-mode="range" class="' + (st.mode === 'range' ? 'active' : '') + '">Entry / Midpoint / Top</button>' +
        '<button type="button" data-mode="plan" class="' + (st.mode === 'plan' ? 'active' : '') + '">Full step pay plan</button>' +
      '</div>';
    return intro + modeSeg +
      '<div id="mode-single"' + (st.mode !== 'single' ? ' hidden' : '') + '>' + singleFields() + '</div>' +
      '<div id="mode-range"' + (st.mode !== 'range' ? ' hidden' : '') + '>' + rangeFields() + '</div>' +
      '<div id="mode-plan"' + (st.mode !== 'plan' ? ' hidden' : '') + '>' + planFields() + '</div>' +
      supplementalSection();
  }

  // A single flat rate — no raise by tenure. Sets BOTH entry and top pay to the
  // same figure, distinct from only knowing (not lacking) one point of a scale.
  function singleFields() {
    return '' +
      field('Position', selP('c-flat-position', POSITIONS, 'Select position…'), null, 'c-flat-position') +
      '<div class="grid cols-2">' +
        field('Pay amount', money('c-flat-amount', '$'), 'One flat rate — no raise by tenure. Sets both entry and top pay to this figure.', 'c-flat-amount') +
        field('Pay period', sel('c-flat-period', PERIODS, 'annual'), null, 'c-flat-period') +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Amount represents', sel('c-flat-basis', BASIS, 'base'), null, 'c-flat-basis') +
        field('Effective date', dateI('c-flat-eff'), null, 'c-flat-eff') +
        field('Shift schedule', sel('c-flat-sched', SCHEDULES, ''), null, 'c-flat-sched') +
      '</div>' +
      field('Scheduled annual hours', numI('c-flat-hours', '2912'), null, 'c-flat-hours');
  }

  // Entry, midpoint, and/or top pay — a common 3-point pay scale, entered together
  // as one submission. Unlike the flat-rate tab, leaving one blank means "unknown",
  // not "same as the others".
  function rangeFields() {
    return '' +
      field('Position', selP('c-position', POSITIONS, 'Select position…'), null, 'c-position') +
      '<div class="grid cols-3">' +
        field('Entry pay', money('c-entry', '$'), null, 'c-entry') +
        field('Midpoint pay', money('c-midpoint', '$'), 'Optional — leave blank if there isn’t one.', 'c-midpoint') +
        field('Top pay', money('c-top', '$'), null, 'c-top') +
      '</div>' +
      '<p class="field-hint">Fill in whichever of these you know — one, two, or all three. Each publishes as its own figure.</p>' +
      '<div class="grid cols-3">' +
        field('Pay period', sel('c-period', PERIODS, 'annual'), null, 'c-period') +
        field('Amount represents', sel('c-basis', BASIS, 'base'), null, 'c-basis') +
        field('Effective date', dateI('c-eff'), null, 'c-eff') +
      '</div>' +
      '<div class="grid cols-2">' +
        field('Shift schedule', sel('c-sched', SCHEDULES, ''), null, 'c-sched') +
        field('Scheduled annual hours', numI('c-hours', '2912'), null, 'c-hours') +
      '</div>';
  }

  function planFields() {
    return '' +
      '<div class="grid cols-2">' +
        field('Classification / position', selP('p-position', POSITIONS, 'Select position…'), 'Stored once for the whole plan — don’t repeat it per step.', 'p-position') +
        field('Effective date', dateI('p-eff'), null, 'p-eff') +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Pay period', sel('p-period', PLAN_PERIODS, 'annual'), 'Sets the unit for every dollar figure in the steps below — switch to “Per hour” if you’re entering hourly rates, not annual salaries.', 'p-period') +
        field('Shift schedule', sel('p-sched', SCHEDULES, ''), null, 'p-sched') +
        field('Scheduled annual hours', numI('p-hours', '2912'), null, 'p-hours') +
      '</div>' +
      field('Plan notes (optional)', '<textarea id="p-notes" placeholder="e.g. steps from the 2026 approved pay scale"></textarea>', null, 'p-notes') +
      '<div class="divider-label">Pay steps</div>' +
      '<p class="field-hint">Base pay is the required, scheduled step amount. Sched OT is an optional add-on kept separate from base. Use the <strong>Top</strong> column to mark whichever step is the top/max pay rate.</p>' +
      '<div id="plan-editor"></div>' +
      '<div class="plan-controls">' +
        '<button type="button" class="btn btn-outline btn-sm" data-plan="add">＋ Add step</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-plan="add5">＋ Add 5 steps</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-plan="dup-last">⧉ Duplicate last</button>' +
      '</div>' +
      '<div id="plan-derived"></div>';
  }

  function supplementalSection() {
    return '<div class="divider-label">Additional / supplemental pay</div>' +
      '<p class="field-hint">Longevity, certifications, education, assignment, holiday, stipends, bonuses — each with its own unit. Kept separate from the base figures above; never added into a reported total.</p>' +
      '<div id="supp-rows"></div>' +
      '<button type="button" class="btn btn-outline btn-sm" id="add-supp">＋ Add pay item</button>';
  }

  function suppRow() {
    return '<div class="supp-row">' +
      selP('', SUPP_TYPES, 'Pay type…').replace('<select id=""', '<select class="s-type" aria-label="Supplemental pay type"') +
      '<input type="text" inputmode="decimal" class="money s-amt" placeholder="Amount" aria-label="Amount">' +
      sel('', UNITS, 'yr').replace('<select id=""', '<select class="s-unit" aria-label="Unit"') +
      '<button type="button" class="btn btn-ghost btn-sm s-rm" aria-label="Remove pay item">✕</button>' +
    '</div>';
  }

  // ── Step editor (state-backed) ──────────────────────────────────────────────────
  function blankStep(startMonths, label) { return { id: 'k' + (_sid++), label: label || '', startMonths: startMonths, basePay: null, sot: null, top: false }; }
  function nextMonths() { var last = st.steps[st.steps.length - 1]; return last ? (Number(last.startMonths) || 0) + 12 : 0; }
  function autoLabel() { return st.steps.length === 0 ? 'Entry' : 'Step ' + (st.steps.length + 1); }

  function renderEditor() {
    var host = document.getElementById('plan-editor');
    if (!host) return;
    var unit = v('p-period') === 'hourly' ? '/hr' : '/yr';
    if (!st.steps.length) { host.innerHTML = '<p class="field-hint">No steps yet — use the controls below to add the first one (Entry).</p>'; updateDerived(); return; }
    var head = '<div class="plan-head"><span>Top</span><span>Step label</span><span>Start (months)</span>' +
      '<span>Base pay <span class="hd-unit">$' + unit + '</span></span>' +
      '<span>Sched OT <span class="hd-unit">$' + unit + '</span></span>' +
      '<span aria-hidden="true"></span></div>';
    var rows = st.steps.map(function (s, i) { return rowHTML(s, i, unit); }).join('');
    host.innerHTML = '<div class="plan-grid" role="group" aria-label="Pay step editor">' + head + rows + '</div>';
    updateDerived();
  }

  function rowHTML(s, i, unit) {
    var n = i + 1, mv = function (x) { return x == null ? '' : Number(x).toLocaleString('en-US'); };
    return '<div class="plan-row" data-i="' + i + '">' +
      '<div class="pc pc-top"><label><input type="radio" name="topstep" data-f="top" ' + (s.top ? 'checked' : '') + ' aria-label="Step ' + n + ' is the top/max pay step"> <span class="cl">Top step</span><span class="top-word">Top</span></label></div>' +
      '<div class="pc"><span class="cl">Step label</span><input type="text" data-f="label" value="' + UI.esc(s.label) + '" placeholder="Entry / Step ' + n + ' / Top" aria-label="Step ' + n + ' label"></div>' +
      '<div class="pc"><span class="cl">Start (months)</span><input type="text" inputmode="numeric" data-f="startMonths" value="' + (s.startMonths == null ? '' : UI.esc(s.startMonths)) + '" placeholder="0" aria-label="Step ' + n + ' starting month"></div>' +
      '<div class="pc"><span class="cl">Base pay (' + unit + ')</span><input type="text" inputmode="decimal" class="money" data-f="basePay" value="' + mv(s.basePay) + '" placeholder="$" aria-label="Step ' + n + ' base pay, ' + unit + '"></div>' +
      '<div class="pc"><span class="cl">Sched OT (' + unit + ')</span><input type="text" inputmode="decimal" class="money" data-f="sot" value="' + mv(s.sot) + '" placeholder="$" aria-label="Step ' + n + ' scheduled overtime, ' + unit + '"></div>' +
      '<div class="pc pc-act">' +
        '<button type="button" class="ib" data-act="insert" aria-label="Insert step after ' + n + '">↴</button>' +
        '<button type="button" class="ib" data-act="up" aria-label="Move step ' + n + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="ib" data-act="down" aria-label="Move step ' + n + ' down"' + (i === st.steps.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="ib" data-act="dup" aria-label="Duplicate step ' + n + '">⧉</button>' +
        '<button type="button" class="ib ib-rm" data-act="remove" aria-label="Remove step ' + n + '">✕</button>' +
      '</div>' +
    '</div>';
  }

  function updateDerived() {
    var host = document.getElementById('plan-derived');
    if (!host) return;
    var steps = st.steps.filter(function (s) { return s.basePay != null; }).map(function (s) { return { startMonths: Number(s.startMonths) || 0, basePay: s.basePay, isTopStep: !!s.top }; });
    if (!steps.length) { host.innerHTML = ''; return; }
    var sum = Lib.planSummary(steps);
    var period = v('p-period') || 'annual';
    var hours = Lib.parseNumber(v('p-hours'));
    var cell = function (val, lab) { return '<div class="dv"><span class="dv-v">' + val + '</span><span class="dv-l">' + lab + '</span></div>'; };
    var entryOut, topOut, extraCell;
    if (period === 'hourly') {
      entryOut = sum.entry != null ? ('$' + sum.entry.toFixed(2) + '/hr') : '—';
      topOut = sum.top != null ? ('$' + sum.top.toFixed(2) + '/hr') : '—';
      extraCell = (hours && sum.entry != null) ? cell(UI.money(Math.round(sum.entry * hours)) + '/yr', 'Entry annualized') : '';
    } else {
      entryOut = UI.money(sum.entry);
      topOut = UI.money(sum.top);
      var eh = hours ? Lib.effectiveHourly(sum.entry, hours) : null;
      extraCell = eh != null ? cell('$' + (Math.round(eh * 100) / 100).toFixed(2) + '/hr', 'Effective hourly') : '';
    }
    host.innerHTML = '<div class="derived-card"><div class="dv-title">Derived from these steps</div><div class="dv-grid">' +
      cell(entryOut, 'Entry pay') +
      cell(topOut, 'Top pay') +
      cell(sum.yearsToTop != null ? sum.yearsToTop + ' yr' : '—', 'Years to top') +
      cell(sum.entryToTopPct != null ? '+' + sum.entryToTopPct + '%' : '—', 'Entry → top') +
      extraCell +
    '</div></div>';
  }

  // ── Step 3 ─────────────────────────────────────────────────────────────────────
  function step3() {
    return '<h2>How do you know this?</h2>' +
      '<p class="muted">Source-backed figures publish as <em>sourced</em>. Unsupported figures publish as <em>provisional</em> and may get extra review.</p>' +
      field('Where does this come from?', selP('src-prov', PROVENANCE, 'Select a source…'), null, 'src-prov') +
      field('Public source link (optional)', '<input id="src-url" type="url" placeholder="https:// — pay plan, careers page, CBA">', null, 'src-url') +
      '<div class="divider-label">Attach a document (optional)</div>' +
      '<label class="upload-area" for="src-file"><input id="src-file" type="file" accept="image/png,image/jpeg,application/pdf" hidden>' +
        '<div class="up-icon" aria-hidden="true">📄</div>' +
        '<div><strong>Click to upload</strong> or drag a file here<div class="field-hint" style="margin-top:2px">PDF, PNG or JPG · up to 10 MB</div></div>' +
        '<div class="up-file" id="up-filename"></div>' +
      '</label>';
  }

  // ── Step 4: review ──────────────────────────────────────────────────────────────
  function step4() {
    var payload = gather();
    return '<h2>Review &amp; submit</h2>' +
      '<p class="muted">Confirm the changes below. Routine submissions publish automatically and are preserved as revisions.</p>' +
      review(payload) +
      '<div class="divider-label">Confirm</div>' +
      '<div class="checkline"><input type="checkbox" id="att-main" required><label for="att-main">I believe this information is accurate, and I understand my submission may be edited, compared, and displayed publicly.</label></div>' +
      (hasFile() ? '<div class="checkline"><input type="checkbox" id="att-file" required><label for="att-file">The file I’m attaching is public/non-sensitive and I have the right to share it.</label></div>' : '');
  }

  function review(payload) {
    var dept = st.type === 'update' ? D.get(st.dept) : null;
    var cur = dept && dept.summary ? dept.summary : {};
    var pv = payload.proposedValues || {};
    var rows = [];
    var kv = function (k, val) { return '<div class="rv-row"><span class="rv-k">' + k + '</span><span class="rv-new">' + val + '</span></div>'; };
    var arrow = function (k, o, nw) { return '<div class="rv-row"><span class="rv-k">' + k + '</span><span class="rv-old">' + (o != null ? o : '—') + '</span><span class="rv-arw">→</span><span class="rv-new">' + nw + '</span></div>'; };

    if (st.type === 'add') rows.push(kv('New department', UI.esc(payload.name || '(unnamed)') + ' · ' + UI.esc(payload.city || '')));
    else rows.push(kv('Department', UI.esc(dept ? dept.name : st.dept)));

    if (payload.mode === 'plan') {
      var pl = payload.plan || {};
      if (pl.classification) rows.push(kv('Classification', UI.esc(pl.classification)));
      rows.push(arrow('Effective date', fmtDate(dept && dept.salary && dept.salary.effectiveDate) || null, UI.esc(fmtDate(pl.effectiveDate) || '—')));
      if (pl.schedule) rows.push(arrow('Schedule', dept ? (dept.scheduleType || null) : null, UI.esc(pl.schedule)));
      if (pl.hoursAnnual) rows.push(kv('Scheduled hours', UI.esc(pl.hoursAnnual)));
      rows.push(kv('Number of steps', (pv.steps || []).length));
      rows.push(arrow('Entry pay', cur.entry != null ? UI.money(cur.entry) : null, pv.entry != null ? UI.money(pv.entry) : '—'));
      rows.push(arrow('Top pay', cur.topBase != null ? UI.money(cur.topBase) : null, pv.top != null ? UI.money(pv.top) : '—'));
      if (pl.yearsToTop != null) rows.push(kv('Years to top', pl.yearsToTop + ' yr'));
    } else if (pv.entry != null || pv.midpoint != null || pv.top != null || pv.reportedEntry != null || pv.reportedMidpoint != null || pv.reportedTop != null) {
      var isTotal = pv.basis === 'total';
      var posLabel = (pv.position || 'Pay') + ' — ' + periodLabel(pv.payPeriod);
      // Entry/midpoint/top each get their own row, compared against the matching
      // career point AND the matching kind of figure — a midpoint amount is never
      // diffed against entry or top, and a "reported total compensation" amount is
      // never diffed against base pay.
      var newEntry = pv.entry != null ? pv.entry : pv.reportedEntry;
      if (newEntry != null) {
        var oldEntry = isTotal ? cur.reportedEntry : cur.entry;
        rows.push(arrow(posLabel + ' (entry)', oldEntry != null ? UI.money(oldEntry) : null, UI.money(newEntry) + basisSuffix(pv.basis)));
      }
      var newMid = pv.midpoint != null ? pv.midpoint : pv.reportedMidpoint;
      if (newMid != null) {
        var oldMid = isTotal ? cur.reportedMidpoint : cur.midpoint;
        rows.push(arrow(posLabel + ' (midpoint)', oldMid != null ? UI.money(oldMid) : null, UI.money(newMid) + basisSuffix(pv.basis)));
      }
      var newTop = pv.top != null ? pv.top : pv.reportedTop;
      if (newTop != null) {
        var oldTop = isTotal ? cur.reportedTop : cur.topBase;
        rows.push(arrow(posLabel + ' (top)', oldTop != null ? UI.money(oldTop) : null, UI.money(newTop) + basisSuffix(pv.basis)));
      }
      if (pv.effectiveDate) rows.push(arrow('Effective date', fmtDate(dept && dept.salary && dept.salary.effectiveDate) || null, UI.esc(fmtDate(pv.effectiveDate))));
      if (pv.schedule) rows.push(arrow('Schedule', dept ? (dept.scheduleType || null) : null, UI.esc(pv.schedule)));
      if (pv.hoursAnnual) rows.push(arrow('Scheduled hours', dept ? (dept.annualScheduledHours || null) : null, UI.esc(pv.hoursAnnual)));
    } else if (pv.schedule || pv.effectiveDate) {
      if (pv.schedule) rows.push(arrow('Schedule', dept ? (dept.scheduleType || null) : null, UI.esc(pv.schedule)));
      if (pv.effectiveDate) rows.push(arrow('Effective date', fmtDate(dept && dept.salary && dept.salary.effectiveDate) || null, UI.esc(fmtDate(pv.effectiveDate))));
    }

    (pv.supplemental || []).forEach(function (s) { rows.push(kv(suppLabel(s.type), UI.money(s.amount) + '/' + unitLabel(s.unit))); });

    var stepsList = '';
    if (payload.mode === 'plan' && (pv.steps || []).length) {
      stepsList = '<div class="rv-steps"><div class="rv-steps-title">Steps</div>' + pv.steps.map(function (s) {
        return '<div class="rv-step"><span>' + UI.esc(s.label || '—') + (s.isTopStep ? ' · top' : '') + '</span><span>' + Math.round((s.startMonths || 0) / 12 * 10) / 10 + ' yr</span><span>' + UI.money(s.basePay) + '</span></div>';
      }).join('') + '</div>';
    }

    var prov = payload.sourceType;
    rows.push('<div class="rv-row"><span class="rv-k">Source</span><span class="rv-new">' + (prov ? UI.esc(provLabel(prov)) : 'Not specified') + ' · ' + (payload.sourceStatus === 'sourced' ? '<span class="chip strong" style="padding:1px 8px">Sourced</span>' : '<span class="chip reported" style="padding:1px 8px">Provisional</span>') + '</span></div>');

    if (rows.length <= 1) return '<div class="notice warn"><span class="notice-icon">⚠</span><div>No changes yet — go back and enter at least one figure.</div></div>';
    return '<div class="review-card">' + rows.join('') + '</div>' + stepsList;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────────
  function wireStep() {
    // type toggle
    document.querySelectorAll('#type-seg [data-type]').forEach(function (b) {
      b.onclick = function () { st.type = b.getAttribute('data-type'); st.step = 1; render(); };
    });
    // mode toggle (step 2)
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.onclick = function () {
        st.mode = b.getAttribute('data-mode');
        document.querySelectorAll('#mode-seg [data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
        var single = document.getElementById('mode-single'), range = document.getElementById('mode-range'), plan = document.getElementById('mode-plan');
        if (single) single.hidden = st.mode !== 'single';
        if (range) range.hidden = st.mode !== 'range';
        if (plan) plan.hidden = st.mode !== 'plan';
        if (st.mode === 'plan' && !st.steps.length) { st.steps.push(blankStep(0, 'Entry')); }
        renderEditor();
      };
    });

    // top-level money fields (single + range modes; plan-level none)
    document.querySelectorAll('#mode-single input.money, #mode-range input.money').forEach(function (el) { el.addEventListener('input', function () { commaFmt(el); }); });

    // dept search
    var ds = document.getElementById('f-dept-search');
    if (ds) {
      if (st.dept) { var d0 = D.get(st.dept); if (d0) ds.value = d0.name + ' — ' + d0.city; }
      renderCurrent();
      ds.addEventListener('input', function () { var m = matchDept(ds.value); st.dept = m ? m.slug : ''; renderCurrent(); });
    }

    // plan editor delegation
    var editor = document.getElementById('plan-editor');
    if (editor) {
      if (st.mode === 'plan' && !st.steps.length) st.steps.push(blankStep(0, 'Entry'));
      renderEditor();
      editor.addEventListener('input', onEditorInput);
      editor.addEventListener('change', onEditorInput);   // radios fire change
      editor.addEventListener('click', onEditorClick);
      var hrs = document.getElementById('p-hours'); if (hrs) hrs.addEventListener('input', updateDerived);
      var per = document.getElementById('p-period'); if (per) per.addEventListener('change', renderEditor);
    }
    // plan controls
    document.querySelectorAll('[data-plan]').forEach(function (b) { b.onclick = function () { planControl(b.getAttribute('data-plan')); }; });

    // supplemental
    var addSupp = document.getElementById('add-supp');
    if (addSupp) { var supp = document.getElementById('supp-rows'); addSupp.onclick = function () { supp.insertAdjacentHTML('beforeend', suppRow()); rewireMoney(supp); rewireSuppRemove(supp); }; }

    // file upload
    var file = document.getElementById('src-file');
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0], name = document.getElementById('up-filename');
      if (f) { if (f.size > 10 * 1024 * 1024) { name.innerHTML = '<span class="field-error">That file is over 10 MB.</span>'; file.value = ''; return; } name.textContent = '✓ ' + f.name; }
      else name.textContent = '';
    });
  }

  function onEditorInput(e) {
    var el = e.target, row = el.closest && el.closest('.plan-row'); if (!row) return;
    var i = parseInt(row.getAttribute('data-i'), 10), f = el.getAttribute('data-f'); if (!(i >= 0) || !f) return;
    var s = st.steps[i]; if (!s) return;
    if (f === 'top') {
      st.steps.forEach(function (x) { x.top = false; }); s.top = !!el.checked;
    } else if (el.classList.contains('money')) {
      commaFmt(el); s[f] = Lib.parseMoney(el.value);
    } else if (f === 'startMonths') {
      s.startMonths = Lib.parseNumber(el.value);
    } else { s[f] = el.value; }
    updateDerived();
  }

  function onEditorClick(e) {
    var b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
    var row = b.closest('.plan-row'), i = parseInt(row.getAttribute('data-i'), 10), act = b.getAttribute('data-act');
    if (act === 'remove') st.steps.splice(i, 1);
    else if (act === 'up' && i > 0) { var t = st.steps[i - 1]; st.steps[i - 1] = st.steps[i]; st.steps[i] = t; }
    else if (act === 'down' && i < st.steps.length - 1) { var t2 = st.steps[i + 1]; st.steps[i + 1] = st.steps[i]; st.steps[i] = t2; }
    else if (act === 'dup') { var c = Object.assign({}, st.steps[i], { id: 'k' + (_sid++) }); st.steps.splice(i + 1, 0, c); }
    else if (act === 'insert') { st.steps.splice(i + 1, 0, blankStep((Number(st.steps[i].startMonths) || 0) + 12, 'Step ' + (i + 2))); }
    renderEditor();
  }

  function planControl(act) {
    if (act === 'add') st.steps.push(blankStep(nextMonths(), autoLabel()));
    else if (act === 'add5') { for (var k = 0; k < 5; k++) st.steps.push(blankStep(nextMonths(), autoLabel())); }
    else if (act === 'dup-last') { var last = st.steps[st.steps.length - 1]; if (last) st.steps.push(Object.assign({}, last, { id: 'k' + (_sid++), startMonths: (Number(last.startMonths) || 0) + 12, top: false })); }
    renderEditor();
  }

  function rewireMoney(scope) { scope.querySelectorAll('input.money').forEach(function (el) { if (el._wired) return; el._wired = true; el.addEventListener('input', function () { commaFmt(el); }); }); }
  function rewireSuppRemove(scope) { scope.querySelectorAll('.s-rm').forEach(function (b) { b.onclick = function () { b.closest('.supp-row').remove(); }; }); }
  function renderCurrent() { var host = document.getElementById('current-values'); if (!host) return; var d = st.dept ? D.get(st.dept) : null; host.innerHTML = d ? currentValuesCard(d) : ''; }
  function matchDept(text) {
    text = String(text || '').toLowerCase().trim(); if (!text) return null;
    var all = D.all();
    return all.find(function (d) { return (d.name + ' — ' + d.city).toLowerCase() === text; }) ||
      all.find(function (d) { return d.name.toLowerCase().indexOf(text) !== -1 || (d.city && d.city.toLowerCase().indexOf(text) !== -1) || (d.county && d.county.toLowerCase().indexOf(text) !== -1); });
  }
  function deptName() { var d = D.get(st.dept); return d ? d.name : 'this department'; }

  // ── Validation ────────────────────────────────────────────────────────────────
  function validateStep() {
    var status = document.getElementById('form-status');
    function fail(msg) { if (status) status.innerHTML = notice('warn', msg); return false; }
    function warnOk(msgs) { if (status && msgs.length) status.innerHTML = notice('info', 'Heads up: ' + msgs.join(' ')); return true; }
    if (status) status.innerHTML = '';
    if (st.step === 1) {
      if (st.type === 'add') {
        if (!v('f-name')) return fail('Enter the department name.');
        if (!v('f-city')) return fail('Enter the city.');
        if (!v('f-county')) return fail('Enter the county.');
        if (!/^\d{5}$/.test(v('f-zip'))) return fail('Enter a valid 5-digit ZIP code — it’s how this department gets placed on the map.');
      }
      else if (!st.dept) return fail('Pick a department from the list.');
      return true;
    }
    if (st.step === 2) {
      var supp = readSupp();
      if (supp.find(function (s) { return s.amount < 0; })) return fail('Supplemental pay can’t be negative.');
      if (st.mode === 'plan') return validatePlan(fail, warnOk, supp);
      if (st.mode === 'range') {
        var entryAmt = Lib.parseMoney(v('c-entry')), midAmt = Lib.parseMoney(v('c-midpoint')), topAmt = Lib.parseMoney(v('c-top'));
        var anyAmt = entryAmt != null || midAmt != null || topAmt != null;
        if (st.type === 'update' && !anyAmt && !supp.length && !v('c-sched') && !v('c-eff')) return fail('Add at least one change — a pay amount, schedule, effective date, or supplemental pay item.');
        if (anyAmt) {
          if ((entryAmt != null && entryAmt < 0) || (midAmt != null && midAmt < 0) || (topAmt != null && topAmt < 0)) return fail('Pay amounts can’t be negative.');
          if (!v('c-position')) return fail('Choose the position this pay is for.');
          if (!v('c-basis')) return fail('Choose what these amounts represent (base, base+OT, or total).');
          if (!v('c-eff')) return fail('Add an effective date for these pay amounts.');
        }
        return true;
      }
      // single (flat rate) mode
      var flatAmt = Lib.parseMoney(v('c-flat-amount'));
      if (st.type === 'update' && flatAmt == null && !supp.length && !v('c-flat-sched') && !v('c-flat-eff')) return fail('Add at least one change — a pay amount, schedule, effective date, or supplemental pay item.');
      if (flatAmt != null) {
        if (flatAmt < 0) return fail('Pay amounts can’t be negative.');
        if (!v('c-flat-position')) return fail('Choose the position this pay is for.');
        if (!v('c-flat-basis')) return fail('Choose what the amount represents (base, base+OT, or total).');
        if (!v('c-flat-eff')) return fail('Add an effective date for the pay amount.');
      }
      return true;
    }
    return true;
  }

  function validatePlan(fail, warnOk, supp) {
    var steps = st.steps;
    var meaningful = steps.filter(function (s) { return s.basePay != null || (s.label && s.label.trim()) || s.startMonths != null; });
    if (st.type === 'update' && !meaningful.length && !supp.length) return fail('Add at least one pay step.');
    if (!meaningful.length) return true; // add flow with no comp — allowed
    if (!v('p-eff')) return fail('Add an effective date for this pay plan.');
    var months = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i], n = i + 1;
      if (!s.label || !s.label.trim()) return fail('Step ' + n + ' needs a label (e.g. Entry, Step 2, Top).');
      if (s.startMonths == null || isNaN(Number(s.startMonths))) return fail('Step ' + n + ' needs a starting month.');
      if (s.basePay == null) return fail('Step ' + n + ' needs a base pay amount.');
      if (s.basePay < 0 || (s.sot != null && s.sot < 0)) return fail('Step ' + n + ' has a negative amount.');
      months.push(Number(s.startMonths));
    }
    for (var j = 1; j < months.length; j++) {
      if (months[j] === months[j - 1]) return fail('Two steps share the same starting month (' + months[j] + '). Each step needs a distinct start.');
      if (months[j] < months[j - 1]) return fail('Steps are out of order — starting months must increase down the list.');
    }
    var tops = steps.filter(function (s) { return s.top; });
    if (tops.length > 1) return fail('Only one step can be marked as the top step.');
    // warnings (non-blocking)
    var warns = [];
    for (var w = 1; w < steps.length; w++) { if (steps[w].basePay < steps[w - 1].basePay) { warns.push('base pay decreases at Step ' + (w + 1) + '.'); break; } }
    if (!tops.length) warns.push('no step is marked as the top step (the last step will be used).');
    if (v('p-sched') && !Lib.parseNumber(v('p-hours'))) warns.push('a shift schedule was set without scheduled annual hours.');
    var sm = Lib.planSummary(steps.filter(function (s) { return s.basePay != null; }).map(function (s) { return { startMonths: Number(s.startMonths) || 0, basePay: s.basePay, isTopStep: !!s.top }; }));
    if (sm.top != null && (sm.top > 400000 || (sm.entry != null && sm.entry < 15000))) warns.push('some figures look unusually high or low — double-check them.');
    return warnOk(warns);
  }

  // ── Gather ────────────────────────────────────────────────────────────────────
  function readSupp() {
    var out = [];
    document.querySelectorAll('#supp-rows .supp-row').forEach(function (r) {
      var type = (r.querySelector('.s-type') || {}).value, amount = Lib.parseMoney((r.querySelector('.s-amt') || {}).value);
      if (!type || amount == null) return;
      out.push({ type: type, amount: amount, unit: (r.querySelector('.s-unit') || {}).value || 'yr' });
    });
    return out;
  }

  function planSteps() {
    return st.steps.filter(function (s) { return s.basePay != null && s.label && s.label.trim(); }).map(function (s) {
      return { label: s.label.trim(), startMonths: Number(s.startMonths) || 0, basePay: s.basePay,
        scheduledOvertime: s.sot != null ? s.sot : null, isTopStep: !!s.top };
    });
  }

  function gather() {
    var base = { submissionType: st.type === 'add' ? 'add' : 'update', mode: st.mode,
      contributorType: (A && A.profile && A.profile.role === 'department') ? 'department' : 'community' };
    var prov = v('src-prov') || null;
    base.sourceType = prov; base.sourceUrl = v('src-url') || null;
    base.sourceStatus = ((prov && SOURCED_PROVENANCE[prov]) || base.sourceUrl) ? 'sourced' : 'provisional';
    base.hasFile = hasFile();
    if (st.type === 'add') Object.assign(base, { name: v('f-name'), city: v('f-city'), county: v('f-county'), zip: v('f-zip'), departmentType: v('f-dtype'), website: v('f-web') });
    else base.departmentSlug = st.dept;

    var pv = { supplemental: readSupp() };
    if (st.mode === 'plan') {
      var steps = planSteps();
      var period = v('p-period');
      var hours = Lib.parseNumber(v('p-hours'));
      base.plan = { classification: v('p-position') || undefined, effectiveDate: v('p-eff') || undefined,
        payPeriod: period || undefined, schedule: v('p-sched') || undefined, hoursAnnual: hours || undefined, notes: v('p-notes') || undefined };
      pv.steps = steps;
      // Derive entry/top for the consensus engine — convert hourly to annual if needed.
      var sum = Lib.planSummary(steps.map(function (s) { return { startMonths: s.startMonths, basePay: s.basePay, isTopStep: s.isTopStep }; }));
      var toAnn = function (x) { return x == null ? undefined : (period === 'hourly' ? Math.round(x * (hours || 2912)) : x); };
      pv.entry = toAnn(sum.entry); pv.top = toAnn(sum.top);
      base.plan.yearsToTop = sum.yearsToTop != null ? sum.yearsToTop : undefined;
      base.effectiveDate = base.plan.effectiveDate;
    } else if (st.mode === 'range') {
      var rBasis = v('c-basis'), rPeriod = v('c-period'), rHours = Lib.parseNumber(v('c-hours'));
      var rToAnn = function (x) { return toAnnual(x, rPeriod, rHours); };
      var entryAmt = rToAnn(Lib.parseMoney(v('c-entry')));
      var midAmt = rToAnn(Lib.parseMoney(v('c-midpoint')));
      var topAmt = rToAnn(Lib.parseMoney(v('c-top')));
      Object.assign(pv, {
        position: v('c-position') || undefined, payPeriod: rPeriod || undefined,
        basis: rBasis || undefined, effectiveDate: v('c-eff') || undefined,
        schedule: v('c-sched') || undefined, hoursAnnual: rHours || undefined
      });
      // Entry/midpoint/top are independent fields, all submitted together — none
      // get mixed with each other. "Reported total compensation" is kept out of
      // base pay entirely (reportedEntry/reportedMidpoint/reportedTop instead) so
      // it can never get displayed or compared as if it were base salary. See
      // derive.js's consensus for each of these.
      var rIsTotal = rBasis === 'total';
      if (entryAmt != null) { if (rIsTotal) pv.reportedEntry = entryAmt; else pv.entry = entryAmt; }
      if (midAmt != null) { if (rIsTotal) pv.reportedMidpoint = midAmt; else pv.midpoint = midAmt; }
      if (topAmt != null) { if (rIsTotal) pv.reportedTop = topAmt; else pv.top = topAmt; }
      base.effectiveDate = pv.effectiveDate;
    } else {
      // Single flat rate — one number, no raise by tenure. Sets BOTH entry and top
      // to the same figure (this is a distinct claim from "I only know entry of a
      // graduated scale", which is what the range tab is for).
      var fBasis = v('c-flat-basis'), fPeriod = v('c-flat-period'), fHours = Lib.parseNumber(v('c-flat-hours'));
      var flatAmt = toAnnual(Lib.parseMoney(v('c-flat-amount')), fPeriod, fHours);
      Object.assign(pv, {
        position: v('c-flat-position') || undefined, payPeriod: fPeriod || undefined,
        basis: fBasis || undefined, effectiveDate: v('c-flat-eff') || undefined,
        schedule: v('c-flat-sched') || undefined, hoursAnnual: fHours || undefined,
        flatRate: true
      });
      if (flatAmt != null) {
        if (fBasis === 'total') { pv.reportedEntry = flatAmt; pv.reportedTop = flatAmt; }
        else { pv.entry = flatAmt; pv.top = flatAmt; }
      }
      base.effectiveDate = pv.effectiveDate;
    }
    if (!pv.supplemental.length) delete pv.supplemental;
    base.proposedValues = pv;
    return base;
  }

  function toAnnual(amount, period, hours) {
    if (amount == null) return null;
    if (period === 'monthly') return Math.round(amount * 12);
    if (period === 'hourly') return Math.round(amount * (hours || 2912));
    return amount;
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  function onSubmit() {
    var status = document.getElementById('form-status');
    if (!document.getElementById('att-main') || !document.getElementById('att-main').checked) { status.innerHTML = notice('warn', 'Please confirm the accuracy statement.'); return; }
    var fileC = document.getElementById('att-file');
    if (fileC && !fileC.checked) { status.innerHTML = notice('warn', 'Please confirm you can share the attached file.'); return; }
    var payload = gather();
    var pv = payload.proposedValues || {};
    var hasAmount = pv.entry != null || pv.midpoint != null || pv.top != null || pv.reportedEntry != null || pv.reportedMidpoint != null || pv.reportedTop != null;
    var hasChange = hasAmount || (pv.steps && pv.steps.length) || (pv.supplemental && pv.supplemental.length) || pv.schedule || pv.effectiveDate || base_effective(payload) || st.type === 'add';
    if (!hasChange) { status.innerHTML = notice('warn', 'No changes to submit — go back and add at least one figure.'); return; }
    if (!(A && A.canContribute())) {
      if (!window.FireDB || !window.FireDB.configured) {
        status.innerHTML = notice('info', '<strong>Preview mode — validated, not saved.</strong> This would publish as a preserved revision. Payload:<pre class="mono" style="white-space:pre-wrap;font-size:.72rem;margin:.5rem 0 0">' + UI.esc(JSON.stringify(payload, null, 2)) + '</pre>');
        return;
      }
      status.innerHTML = notice('warn', 'Please sign in with a verified email to publish. <a href="/sign-in.html">Sign in →</a>');
      return;
    }
    save(payload).then(function () {
      var host = document.getElementById('submit-body');
      host.innerHTML = '<div class="notice info" style="font-size:1rem"><span class="notice-icon">✓</span><div><strong>Thank you — your submission is published</strong> and preserved as a revision. The community consensus will update automatically.<div style="margin-top:.75rem">' +
        (st.dept ? '<a class="btn btn-outline btn-sm" href="/departments/' + UI.esc(st.dept) + '/">View department</a> ' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="location.reload()">Submit another</button></div></div></div>';
    }).catch(function (err) { status.innerHTML = notice('warn', 'Could not save: ' + UI.esc(err.message)); });
  }
  function base_effective(p) { return !!(p.plan && p.plan.effectiveDate); }

  function pruneUndefined(o) {
    if (Array.isArray(o)) { o.forEach(pruneUndefined); return o; }
    if (o && typeof o === 'object' && o.constructor === Object) { Object.keys(o).forEach(function (k) { if (o[k] === undefined) delete o[k]; else pruneUndefined(o[k]); }); }
    return o;
  }
  async function save(payload) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    pruneUndefined(payload);
    payload.contributorId = A.user.uid; payload.submittedAt = F.serverTimestamp();
    payload.status = 'published'; payload.automatedFlags = [];
    var col = payload.submissionType === 'add' ? 'department_requests' : 'submissions';
    await F.addDoc(F.collection(db.db, col), payload);
  }

  // ── Labels ────────────────────────────────────────────────────────────────────
  function hasFile() { var f = document.getElementById('src-file'); return !!(f && f.files && f.files.length); }
  function periodLabel(p) { return ({ annual: 'per year', monthly: 'per month', hourly: 'per hour' })[p] || 'per year'; }
  function unitLabel(u) { return ({ yr: 'yr', mo: 'mo', hr: 'hr', pct: '% base' })[u] || 'yr'; }
  function basisSuffix(b) { return b === 'total' ? ' (total comp)' : b === 'base-ot' ? ' (base + OT)' : ''; }
  function suppLabel(t) { var f = SUPP_TYPES.find(function (x) { return x[0] === t; }); return f ? f[1] : t; }
  function provLabel(t) { var f = PROVENANCE.find(function (x) { return x[0] === t; }); return f ? f[1] : t; }
  function notice(kind, html) { return '<div class="notice ' + kind + '"><span class="notice-icon">' + (kind === 'warn' ? '⚠' : 'ℹ') + '</span><div>' + html + '</div></div>'; }
})();
