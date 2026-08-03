/*
 * submit.js — Guided submission wizard (submit.html).
 *
 * Four steps: (1) Department & type, (2) Compensation, (3) Source, (4) Review.
 * Two flows: update an existing department, or add a new one. Compensation is
 * captured as structured fields (position, career point, pay period, amount,
 * basis, effective date, schedule) plus repeatable supplemental-pay rows that
 * each carry a unit ($/yr, $/mo, $/hr, % of base). The Review step shows an
 * old → new diff against the department's current values. Source provenance
 * ("how do you know this?") drives whether a submission publishes as sourced or
 * provisional. Writes preserved revision docs to Firestore; preview mode otherwise.
 */
(function () {
  'use strict';
  var UI = window.FireUI, Lib = window.FireSalaryLib, D = window.FireData, A = window.FireAuth;

  var POSITIONS = ['Recruit', 'Firefighter/EMT', 'Firefighter/Paramedic', 'Driver/Engineer', 'Apparatus Operator', 'Lieutenant', 'Captain', 'Battalion Chief', 'Other'];
  var CAREER = [['academy', 'Academy / recruit'], ['entry', 'Entry (post-academy)'], ['step', 'Step (mid-career)'], ['top', 'Top pay']];
  var PERIODS = [['annual', 'Per year'], ['monthly', 'Per month'], ['hourly', 'Per hour']];
  var BASIS = [['base', 'Base pay only'], ['base-ot', 'Base + scheduled overtime'], ['total', 'Reported total compensation']];
  var UNITS = [['yr', '$/yr'], ['mo', '$/mo'], ['hr', '$/hr'], ['pct', '% of base']];
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

  // Wizard state
  var st = {
    type: 'update',     // 'update' | 'add'
    step: 1,
    dept: '',
    supplemental: []    // [{type, amount, unit}]
  };
  var totalSteps = 4;

  document.addEventListener('DOMContentLoaded', function () {
    D.load().then(function () {
      var p = new URLSearchParams(location.search);
      if (p.get('mode') === 'add') st.type = 'add';
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
  function field(label, control, hint) {
    return '<div class="field"><label>' + label + '</label>' + control + (hint ? '<div class="field-hint">' + hint + '</div>' : '') + '</div>';
  }
  function txt(id, ph, val) { return '<input id="' + id + '" type="text" placeholder="' + (ph || '') + '" value="' + (val != null ? UI.esc(val) : '') + '">'; }
  function money(id, ph) { return '<input id="' + id + '" type="text" inputmode="numeric" class="money" placeholder="' + (ph || '$') + '">'; }
  function sel(id, opts, selVal) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + UI.esc(v) + '"' + (selVal === v ? ' selected' : '') + '>' + UI.esc(l) + '</option>';
    }).join('') + '</select>';
  }
  function selPlaceholder(id, opts, ph) {
    return '<select id="' + id + '"><option value="">' + (ph || 'Select…') + '</option>' +
      opts.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + UI.esc(v) + '">' + UI.esc(l) + '</option>'; }).join('') + '</select>';
  }
  function v(id) { var el = document.getElementById(id); return el ? String(el.value).trim() : ''; }
  function setv(id, val) { var el = document.getElementById(id); if (el) el.value = val; }

  // ── Step indicator + shell ────────────────────────────────────────────────────
  var STEP_LABELS = ['Department', 'Compensation', 'Source', 'Review'];
  function indicator() {
    return '<div class="wiz-steps">' + STEP_LABELS.map(function (lab, i) {
      var n = i + 1, cls = n === st.step ? 'active' : (n < st.step ? 'done' : '');
      return '<div class="wiz-step ' + cls + '"><span class="dot">' + (n < st.step ? '✓' : n) + '</span><span class="lab">' + lab + '</span></div>';
    }).join('<span class="wiz-sep"></span>') + '</div>';
  }

  // All step panels stay in the DOM (only the active one shown) so field values
  // persist across Back/Next and the Review reflects them.
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
      '<div id="form-status" style="margin-top:1rem"></div>';
    wireStep();
    updateChrome();
  }

  function updateChrome() {
    var ind = document.getElementById('wiz-indicator'); if (ind) ind.innerHTML = indicator();
    var navc = document.getElementById('wiz-nav-c'); if (navc) navc.innerHTML = nav();
    document.querySelectorAll('.wiz-panel').forEach(function (p) {
      p.style.display = (parseInt(p.getAttribute('data-step'), 10) === st.step) ? '' : 'none';
    });
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

  // ── Step 1: department + type ──────────────────────────────────────────────────
  function step1() {
    var typeToggle =
      '<div class="seg" id="type-seg" role="group" aria-label="Submission type">' +
        '<button type="button" data-type="update" class="' + (st.type === 'update' ? 'active' : '') + '">Update a department</button>' +
        '<button type="button" data-type="add" class="' + (st.type === 'add' ? 'active' : '') + '">Add a new department</button>' +
      '</div>';

    if (st.type === 'add') {
      return '<h2>Add a department</h2>' + typeToggle +
        '<p class="muted">Add a Texas fire department that isn’t listed yet.</p>' +
        '<div class="grid cols-2">' + field('Department name', txt('f-name', 'e.g. Sample Fire Department')) + field('City', txt('f-city')) + '</div>' +
        '<div class="grid cols-3">' + field('County', txt('f-county')) + field('ZIP', '<input id="f-zip" type="text" inputmode="numeric" maxlength="5">') +
          field('Type', sel('f-dtype', [['municipal', 'Municipal'], ['esd', 'Emergency services district'], ['county', 'County'], ['university', 'University'], ['airport', 'Airport'], ['fire-rescue-district', 'Fire-rescue district'], ['combination', 'Combination'], ['other', 'Other']])) + '</div>' +
        field('Website or careers URL', '<input id="f-web" type="url" placeholder="https://">');
    }

    var opts = D.all().map(function (d) { return d.name + ' — ' + d.city; });
    return '<h2>Which department?</h2>' + typeToggle +
      field('Search for a department',
        '<input id="f-dept-search" type="text" list="dept-list" autocomplete="off" placeholder="Type a department, city, or county…">' +
        '<datalist id="dept-list">' + D.all().map(function (d) { return '<option value="' + UI.esc(d.name + ' — ' + d.city) + '"></option>'; }).join('') + '</datalist>',
        'Start typing — 54 departments listed.') +
      '<div id="current-values"></div>';
  }

  function currentValuesCard(dept) {
    var s = dept.summary || {};
    if (!s.hasSalary) return '<div class="notice info" style="margin-top:.5rem"><span class="notice-icon">ℹ</span><div><strong>' + UI.esc(dept.name) + '</strong> has no salary on file yet — anything you add will be its first report.</div></div>';
    var row = function (k, val) { return '<div class="cv-row"><span>' + k + '</span><strong>' + val + '</strong></div>'; };
    return '<div class="card card-tight cv-card" style="margin-top:.75rem"><div class="cv-title">Current values for ' + UI.esc(dept.name) + '</div>' +
      row('Entry pay', UI.money(s.entry)) +
      row('Top pay', s.topBase ? UI.money(s.topBase) : '—') +
      row('Years to top', s.yearsToTop != null ? s.yearsToTop + ' yr' : '—') +
      row('Schedule', dept.scheduleType || '—') +
      row('Effective date', (dept.salary && dept.salary.effectiveDate) || '—') +
      '<p class="field-hint" style="margin:.5rem 0 0">Only fill in what you’re changing on the next step.</p></div>';
  }

  // ── Step 2: compensation ────────────────────────────────────────────────────────
  function step2() {
    if (st.type === 'add') {
      return '<h2>Compensation (optional)</h2><p class="muted">Add starting pay for ' + UI.esc(deptName()) + ' now, or skip and let the community fill it in.</p>' + compFields();
    }
    return '<h2>What are you changing?</h2><p class="muted">For ' + UI.esc(deptName()) + '. Fill in only the figures you’re updating.</p>' + compFields();
  }

  function compFields() {
    return '' +
      '<div class="grid cols-2">' +
        field('Position', selPlaceholder('c-position', POSITIONS, 'Select position…')) +
        field('Career point', selPlaceholder('c-career', CAREER, 'Select…')) +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Amount', money('c-amount', '$')) +
        field('Pay period', sel('c-period', PERIODS, 'annual')) +
        field('Amount represents', sel('c-basis', BASIS, 'base')) +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Effective date', '<input id="c-eff" type="text" inputmode="numeric" placeholder="2026-01-01 or 2026">') +
        field('Shift schedule', sel('c-sched', [['', '—'], '24/48', '48/96', '24/72', '40-hour'], '')) +
        field('Scheduled annual hours', '<input id="c-hours" type="text" inputmode="numeric" placeholder="2912">') +
      '</div>' +
      // Optional full step plan
      '<details class="filter-group"><summary>Enter the full step plan (optional)</summary><div style="margin-top:.6rem">' +
        '<p class="field-hint">One card per step. Fill only the columns you have.</p>' +
        '<div id="step-cards"></div>' +
        '<button type="button" class="btn btn-outline btn-sm" id="add-step">＋ Add step</button>' +
      '</div></details>' +
      // Supplemental pay
      '<div class="divider-label">Additional / supplemental pay</div>' +
      '<p class="field-hint">Longevity, certifications, education, assignment, holiday, stipends, bonuses — each with its own unit.</p>' +
      '<div id="supp-rows"></div>' +
      '<button type="button" class="btn btn-outline btn-sm" id="add-supp">＋ Add pay item</button>';
  }

  function suppRow(row) {
    row = row || {};
    return '<div class="supp-row">' +
      selPlaceholder('', SUPP_TYPES, 'Pay type…').replace('<select id=""', '<select class="s-type"') +
      '<input type="text" inputmode="numeric" class="money s-amt" placeholder="Amount">' +
      sel('', UNITS, 'yr').replace('<select id=""', '<select class="s-unit"') +
      '<button type="button" class="btn btn-ghost btn-sm s-rm" aria-label="Remove">✕</button>' +
    '</div>';
  }

  function stepCard(i) {
    return '<div class="step-card"><div class="sc-head">Step ' + (i + 1) + ' <button type="button" class="btn btn-ghost btn-sm sc-rm" aria-label="Remove step">✕</button></div>' +
      '<div class="grid cols-2">' +
        field('Step name', '<input type="text" class="k-name" placeholder="Firefighter">') +
        field('Months in service (start)', '<input type="text" inputmode="numeric" class="k-months" placeholder="0">') +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Base annual', '<input type="text" inputmode="numeric" class="money k-base" placeholder="$">') +
        field('Scheduled OT', '<input type="text" inputmode="numeric" class="money k-ot" placeholder="$">') +
        field('Reported total', '<input type="text" inputmode="numeric" class="money k-total" placeholder="$">') +
      '</div></div>';
  }

  // ── Step 3: source ──────────────────────────────────────────────────────────────
  function step3() {
    return '<h2>How do you know this?</h2>' +
      '<p class="muted">Source-backed figures publish as <em>sourced</em>. Unsupported figures publish as <em>provisional</em> and may get extra review.</p>' +
      field('Where does this come from?', selPlaceholder('src-prov', PROVENANCE, 'Select a source…')) +
      field('Public source link (optional)', '<input id="src-url" type="url" placeholder="https:// — pay plan, careers page, CBA">') +
      '<div class="divider-label">Attach a document (optional)</div>' +
      '<label class="upload-area" for="src-file"><input id="src-file" type="file" accept="image/png,image/jpeg,application/pdf" hidden>' +
        '<div class="up-icon" aria-hidden="true">📄</div>' +
        '<div><strong>Click to upload</strong> or drag a file here<div class="field-hint" style="margin-top:2px">PDF, PNG or JPG · up to 10 MB</div></div>' +
        '<div class="up-file" id="up-filename"></div>' +
      '</label>' +
      '<div id="file-confirms"></div>';
  }

  // ── Step 4: review ──────────────────────────────────────────────────────────────
  function step4() {
    var payload = gather();
    return '<h2>Review &amp; submit</h2>' +
      '<p class="muted">Confirm the changes below. Routine submissions publish automatically and are preserved as revisions.</p>' +
      reviewDiff(payload) +
      '<div class="divider-label">Confirm</div>' +
      '<div class="checkline"><input type="checkbox" id="att-main" required><label for="att-main">I believe this information is accurate, and I understand my submission may be edited, compared, and displayed publicly.</label></div>' +
      (hasFile() ? '<div class="checkline"><input type="checkbox" id="att-file" required><label for="att-file">The file I’m attaching is public/non-sensitive and I have the right to share it.</label></div>' : '');
  }

  function reviewDiff(payload) {
    var rows = [];
    var arrow = function (label, oldV, newV) { return '<div class="rv-row"><span class="rv-k">' + label + '</span><span class="rv-old">' + (oldV != null ? oldV : '—') + '</span><span class="rv-arw">→</span><span class="rv-new">' + newV + '</span></div>'; };
    if (st.type === 'add') {
      rows.push('<div class="rv-row"><span class="rv-k">New department</span><span class="rv-new">' + UI.esc(payload.name || '(unnamed)') + ' · ' + UI.esc(payload.city || '') + '</span></div>');
    }
    var dept = st.type === 'update' ? D.get(st.dept) : null;
    var cur = dept && dept.summary ? dept.summary : {};
    var pv = payload.proposedValues || {};
    if (pv.amount != null) {
      var careerTop = pv.careerPoint === 'top';
      var oldVal = careerTop ? (cur.topBase != null ? UI.money(cur.topBase) : null) : (cur.entry != null ? UI.money(cur.entry) : null);
      rows.push(arrow((careerTop ? 'Top' : (pv.position || 'Pay')) + ' — ' + periodLabel(pv.payPeriod), oldVal, UI.money(pv.amount) + basisSuffix(pv.basis)));
    }
    if (pv.effectiveDate) rows.push(arrow('Effective date', (dept && dept.salary && dept.salary.effectiveDate) || null, UI.esc(pv.effectiveDate)));
    if (pv.schedule) rows.push(arrow('Schedule', dept ? (dept.scheduleType || null) : null, UI.esc(pv.schedule)));
    if (pv.hoursAnnual) rows.push(arrow('Scheduled hours', dept ? (dept.annualScheduledHours || null) : null, UI.esc(pv.hoursAnnual)));
    (pv.steps || []).length && rows.push('<div class="rv-row"><span class="rv-k">Full step plan</span><span class="rv-new">' + pv.steps.length + ' step' + (pv.steps.length === 1 ? '' : 's') + '</span></div>');
    (pv.supplemental || []).forEach(function (s) {
      rows.push('<div class="rv-row"><span class="rv-k">' + UI.esc(suppLabel(s.type)) + '</span><span class="rv-new">' + UI.money(s.amount) + '/' + unitLabel(s.unit) + '</span></div>');
    });
    var prov = payload.sourceType;
    rows.push('<div class="rv-row"><span class="rv-k">Source</span><span class="rv-new">' + (prov ? UI.esc(provLabel(prov)) : 'Not specified') + ' · ' + (payload.sourceStatus === 'sourced' ? '<span class="chip strong" style="padding:1px 8px">Sourced</span>' : '<span class="chip reported" style="padding:1px 8px">Provisional</span>') + '</span></div>');
    if (!rows.length) return '<div class="notice warn"><span class="notice-icon">⚠</span><div>No changes yet — go back and enter at least one figure.</div></div>';
    return '<div class="review-card">' + rows.join('') + '</div>';
  }

  // ── Wiring ────────────────────────────────────────────────────────────────────
  function wireStep() {
    // type toggle
    document.querySelectorAll('#type-seg [data-type]').forEach(function (b) {
      b.onclick = function () { st.type = b.getAttribute('data-type'); st.step = 1; render(); };
    });

    // money comma formatting
    document.querySelectorAll('input.money').forEach(function (el) {
      el.addEventListener('input', function () {
        var digits = el.value.replace(/[^\d]/g, '');
        el.value = digits ? Number(digits).toLocaleString('en-US') : '';
      });
    });

    // step 1: dept search
    var ds = document.getElementById('f-dept-search');
    if (ds) {
      if (st.dept) { var d0 = D.get(st.dept); if (d0) ds.value = d0.name + ' — ' + d0.city; }
      renderCurrent();
      ds.addEventListener('input', function () {
        var m = matchDept(ds.value);
        st.dept = m ? m.slug : '';
        renderCurrent();
      });
    }

    // step 2: step-plan cards + supplemental rows
    var addStep = document.getElementById('add-step');
    if (addStep) {
      var cards = document.getElementById('step-cards');
      var idx = { n: 0 };
      addStep.onclick = function () { cards.insertAdjacentHTML('beforeend', stepCard(idx.n++)); rewireMoney(cards); rewireStepRemove(cards); };
    }
    var addSupp = document.getElementById('add-supp');
    if (addSupp) {
      var supp = document.getElementById('supp-rows');
      addSupp.onclick = function () { supp.insertAdjacentHTML('beforeend', suppRow()); rewireMoney(supp); rewireSuppRemove(supp); };
    }

    // step 3: file upload
    var file = document.getElementById('src-file');
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      var name = document.getElementById('up-filename');
      var confirms = document.getElementById('file-confirms');
      if (f) {
        if (f.size > 10 * 1024 * 1024) { name.innerHTML = '<span class="field-error">That file is over 10 MB.</span>'; file.value = ''; if (confirms) confirms.innerHTML = ''; return; }
        name.textContent = '✓ ' + f.name;
      } else { name.textContent = ''; }
    });
  }

  function rewireMoney(scope) {
    scope.querySelectorAll('input.money').forEach(function (el) {
      if (el._wired) return; el._wired = true;
      el.addEventListener('input', function () { var d = el.value.replace(/[^\d]/g, ''); el.value = d ? Number(d).toLocaleString('en-US') : ''; });
    });
  }
  function rewireStepRemove(scope) { scope.querySelectorAll('.sc-rm').forEach(function (b) { b.onclick = function () { b.closest('.step-card').remove(); }; }); }
  function rewireSuppRemove(scope) { scope.querySelectorAll('.s-rm').forEach(function (b) { b.onclick = function () { b.closest('.supp-row').remove(); }; }); }

  function renderCurrent() {
    var host = document.getElementById('current-values');
    if (!host) return;
    var d = st.dept ? D.get(st.dept) : null;
    host.innerHTML = d ? currentValuesCard(d) : '';
  }

  function matchDept(text) {
    text = String(text || '').toLowerCase().trim();
    if (!text) return null;
    var all = D.all();
    var exact = all.find(function (d) { return (d.name + ' — ' + d.city).toLowerCase() === text; });
    if (exact) return exact;
    return all.find(function (d) { return d.name.toLowerCase().indexOf(text) !== -1 || (d.city && d.city.toLowerCase().indexOf(text) !== -1) || (d.county && d.county.toLowerCase().indexOf(text) !== -1); });
  }
  function deptName() { var d = D.get(st.dept); return d ? d.name : 'this department'; }

  // ── Validation ────────────────────────────────────────────────────────────────
  function validateStep() {
    var status = document.getElementById('form-status');
    function fail(msg) { if (status) status.innerHTML = notice('warn', msg); return false; }
    if (status) status.innerHTML = '';
    if (st.step === 1) {
      if (st.type === 'add') { if (!v('f-name')) return fail('Enter the department name.'); if (!v('f-city')) return fail('Enter the city.'); }
      else if (!st.dept) return fail('Pick a department from the list.');
      return true;
    }
    if (st.step === 2) {
      var amt = Lib.parseMoney(v('c-amount'));
      var steps = readSteps();
      var supp = readSupp();
      if (st.type === 'update' && amt == null && !steps.length && !supp.length && !v('c-sched') && !v('c-eff')) {
        return fail('Add at least one change — a pay amount, schedule, effective date, step plan, or supplemental pay item.');
      }
      if (amt != null) {
        if (amt < 0) return fail('Pay amounts can’t be negative.');
        if (!v('c-position')) return fail('Choose the position this pay is for.');
        if (!v('c-eff')) return fail('Add an effective date for the pay amount.');
      }
      var bad = supp.find(function (s) { return s.amount != null && s.amount < 0; });
      if (bad) return fail('Supplemental pay amounts can’t be negative.');
      return true;
    }
    return true;
  }

  // ── Gather ────────────────────────────────────────────────────────────────────
  function readSteps() {
    var out = [];
    document.querySelectorAll('#step-cards .step-card').forEach(function (c) {
      var name = (c.querySelector('.k-name') || {}).value || '';
      var base = Lib.parseMoney((c.querySelector('.k-base') || {}).value);
      if (!name.trim() && base == null) return;
      out.push({ stepName: name.trim(), minimumMonths: Lib.parseNumber((c.querySelector('.k-months') || {}).value),
        baseAnnualSalary: base, scheduledOvertime: Lib.parseMoney((c.querySelector('.k-ot') || {}).value),
        reportedAnnualCompensation: Lib.parseMoney((c.querySelector('.k-total') || {}).value) });
    });
    return out;
  }
  function readSupp() {
    var out = [];
    document.querySelectorAll('#supp-rows .supp-row').forEach(function (r) {
      var type = (r.querySelector('.s-type') || {}).value;
      var amount = Lib.parseMoney((r.querySelector('.s-amt') || {}).value);
      if (!type || amount == null) return;
      out.push({ type: type, amount: amount, unit: (r.querySelector('.s-unit') || {}).value || 'yr' });
    });
    return out;
  }

  function gather() {
    var base = { submissionType: st.type === 'add' ? 'add' : 'update', contributorType: (A && A.profile && A.profile.role === 'department') ? 'department' : 'community' };
    var prov = v('src-prov') || null;
    base.sourceType = prov;
    base.sourceUrl = v('src-url') || null;
    base.sourceStatus = (prov && SOURCED_PROVENANCE[prov]) || base.sourceUrl ? 'sourced' : 'provisional';
    base.hasFile = hasFile();

    if (st.type === 'add') {
      Object.assign(base, { name: v('f-name'), city: v('f-city'), county: v('f-county'), zip: v('f-zip'), departmentType: v('f-dtype'), website: v('f-web') });
    } else {
      base.departmentSlug = st.dept;
    }

    var amount = Lib.parseMoney(v('c-amount'));
    var career = v('c-career');
    // Map the amount to an annual entry/top figure for the consensus engine.
    var annual = toAnnual(amount, v('c-period'), Lib.parseNumber(v('c-hours')));
    var pv = {
      position: v('c-position') || undefined,
      careerPoint: career || undefined,
      payPeriod: v('c-period') || undefined,
      amount: amount != null ? amount : undefined,
      basis: v('c-basis') || undefined,
      effectiveDate: v('c-eff') || undefined,
      schedule: v('c-sched') || undefined,
      hoursAnnual: Lib.parseNumber(v('c-hours')) || undefined,
      steps: readSteps(),
      supplemental: readSupp()
    };
    // Feed the consensus engine's entry/top keys.
    if (annual != null) { if (career === 'top') pv.top = annual; else pv.entry = annual; }
    if (!pv.steps.length) delete pv.steps;
    if (!pv.supplemental.length) delete pv.supplemental;
    base.effectiveDate = pv.effectiveDate;
    base.proposedValues = pv;
    base.notes = '';
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
    var hasChange = pv.amount != null || (pv.steps && pv.steps.length) || (pv.supplemental && pv.supplemental.length) || pv.schedule || pv.effectiveDate || st.type === 'add';
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
      host.innerHTML = '<div class="notice info" style="font-size:1rem"><span class="notice-icon">✓</span><div><strong>Thank you — your submission is published</strong> and preserved as a revision. The community consensus will update automatically.<div style="margin-top:.75rem"><a class="btn btn-outline btn-sm" href="/departments/' + UI.esc(st.dept) + '/">View department</a> <button class="btn btn-ghost btn-sm" onclick="location.reload()">Submit another</button></div></div></div>';
    }).catch(function (err) { status.innerHTML = notice('warn', 'Could not save: ' + UI.esc(err.message)); });
  }

  function pruneUndefined(o) {
    if (Array.isArray(o)) { o.forEach(pruneUndefined); return o; }
    if (o && typeof o === 'object' && o.constructor === Object) {
      Object.keys(o).forEach(function (k) { if (o[k] === undefined) delete o[k]; else pruneUndefined(o[k]); });
    }
    return o;
  }

  async function save(payload) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    pruneUndefined(payload);
    payload.contributorId = A.user.uid;
    payload.submittedAt = F.serverTimestamp();
    payload.status = payload.sourceStatus === 'sourced' ? 'published' : 'published'; // both publish; status field records provenance
    payload.automatedFlags = [];
    var col = payload.submissionType === 'add' ? 'department_requests' : 'submissions';
    await F.addDoc(F.collection(db.db, col), payload);
  }

  // ── Labels ────────────────────────────────────────────────────────────────────
  function hasFile() { var f = document.getElementById('src-file'); return !!(f && f.files && f.files.length); }
  function periodLabel(p) { var m = { annual: 'per year', monthly: 'per month', hourly: 'per hour' }; return m[p] || 'per year'; }
  function unitLabel(u) { var m = { yr: 'yr', mo: 'mo', hr: 'hr', pct: '% base' }; return m[u] || 'yr'; }
  function basisSuffix(b) { return b === 'total' ? ' (total comp)' : b === 'base-ot' ? ' (base + OT)' : ''; }
  function suppLabel(t) { var f = SUPP_TYPES.find(function (x) { return x[0] === t; }); return f ? f[1] : t; }
  function provLabel(t) { var f = PROVENANCE.find(function (x) { return x[0] === t; }); return f ? f[1] : t; }
  function notice(kind, html) { return '<div class="notice ' + kind + '"><span class="notice-icon">' + (kind === 'warn' ? '⚠' : 'ℹ') + '</span><div>' + html + '</div></div>'; }
})();
