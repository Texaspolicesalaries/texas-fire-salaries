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

  // No classification/position picker anywhere in this form, by design. Every
  // base figure it collects describes the ONE firefighter base scale, because
  // nothing downstream partitions consensus by classification (js/derive.js
  // passes it straight through for display) -- so a "Firefighter-Paramedic"
  // plan's entry/top would compete against a "Firefighter" plan's as rival
  // claims about the same number. Paramedic and EMT differentials are add-ons
  // collected under Additional/supplemental pay (paramedic-incentive, emt),
  // which is what drives the paramedicIncentive filter flag. See the ADD-ON
  // note in js/aggregate.js -- entryMedic was removed for this same reason.
  // Academy pay is likewise its own flat field (pv.recruit), never a step plan.
  var PERIODS = [['annual', 'Per year'], ['monthly', 'Per month'], ['hourly', 'Per hour']];
  var PLAN_PERIODS = [['annual', 'Per year'], ['hourly', 'Per hour']];
  var BASIS = [['base', 'Base pay only'], ['base-ot', 'Base + scheduled overtime'], ['total', 'Reported total compensation']];
  var UNITS = [['yr', '$/yr'], ['mo', '$/mo'], ['hr', '$/hr'], ['pct', '% of base']];
  // Real departments run cycles this list can't name — "Modified 24-hour
  // (24 on/72 off; 48 on/72 off)" is a live example. schema.md already allows a
  // custom string for scheduleType, so the form just needs somewhere to type it.
  // Picking 'other' reveals a free-text box AND matters for the maths: an
  // unrecognized schedule makes Lib.scheduleHours return null, and js/derive.js
  // then falls back to 2,912 — a 24/48 assumption that would publish a wrong
  // effective hourly for anyone on a shorter cycle. Hence the hours prompt.
  var SCHEDULES = [['', '—'], '24/48', '48/96', '24/72', '40-hour', ['other', 'Other / modified — describe']];
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
  // Which step (if any) is currently showing a non-blocking warning awaiting a
  // second "Continue" click to confirm past it — see wireNav()/validateStep().
  var _pendingWarnStep = null;
  // ...and the exact message they were shown. Confirming past one warning must
  // not wave through a DIFFERENT one: fix an unrecognized ZIP into a Texas ZIP
  // that belongs to another city and the second click would have proceeded
  // without ever showing the mismatch, because only the step number was
  // remembered.
  var _pendingWarnMsg = null;

  document.addEventListener('DOMContentLoaded', function () {
    D.load().then(function () {
      var p = new URLSearchParams(location.search);
      if (p.get('mode') === 'add') st.type = 'add';
      if (p.get('mode') === 'step') st.mode = 'plan';
      // An UPDATE opens on Entry/Midpoint/Top, not the flat-rate tab. Single
      // mode publishes one number as BOTH entry and top — correct for a
      // genuinely flat-rate department, destructive for one with a pay scale.
      // As the default, prefilled with the department's current entry pay, it
      // turned "correct the entry pay" into "republish top pay as the entry
      // figure", flattening a 60k–95k range to 62k–62k in one submission.
      // Entry/Midpoint/Top treats a blank box as "unknown" instead, which is
      // what "edit only what's different" needs to be safe.
      else if (st.type === 'update') st.mode = 'range';
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

  // ── Prefill + dirty tracking ────────────────────────────────────────────────
  // Update forms start pre-populated with the department's current values, so a
  // contributor can see what they're changing instead of guessing which of the
  // blanks differ. But a prefilled value must never be SUBMITTED unless it was
  // actually edited: every figure in a submission joins a consensus cluster and
  // counts toward "Strong community agreement" and trusted-contributor
  // promotion, so carrying untouched values along would manufacture agreement
  // nobody expressed — and would make the history diff claim changes that never
  // happened. Hence: prefill for the eye, submit only what the hand touched.
  var _dirty = {};
  // The step editor holds state rather than DOM values, so it needs its own
  // pair: whether it was seeded from the current plan, and whether the
  // contributor has since touched it. A seeded-but-untouched plan must not be
  // republished as if it were freshly reported.
  var _stepsPrefilled = false;
  var _stepsDirty = false;
  // The seeded step table as it arrived, so "did they change the plan?" can be
  // answered by comparing tables rather than by whether any key was pressed in
  // one — retyping the same figures is not a new report of them.
  var _stepsSnapshot = null;
  // Supplemental pay rows seeded from what the department already reports, and
  // the signature of each as it arrived. Same rule as every other prefilled
  // field: shown so a contributor can correct it, submitted only if they did.
  var _suppPrefill = [];
  var _suppPrefilled = false;
  // Identity of one supplemental row for change detection. The label only
  // participates for "other", matching Lib.supplementalKey — every other type
  // already names itself, so two rows of the same type ARE the same item.
  function suppSig(type, label, amount, unit) {
    return [String(type || ''), String(label || '').trim().toLowerCase(),
      amount == null ? '' : amount, String(unit || 'yr')].join('|');
  }
  function rowSig(r) {
    var type = (r.querySelector('.s-type') || {}).value || '';
    var label = type === 'other' ? ((r.querySelector('.s-label') || {}).value || '') : '';
    return suppSig(type, label, Lib.parseMoney((r.querySelector('.s-amt') || {}).value),
      (r.querySelector('.s-unit') || {}).value);
  }
  function stepsSignature(steps) {
    return JSON.stringify((steps || []).map(function (x) {
      return [String(x.label || '').trim(), Number(x.startMonths) || 0, x.basePay, x.sot, !!x.top];
    }));
  }
  function stepsUnchanged() {
    return _stepsPrefilled && _stepsSnapshot != null && stepsSignature(st.steps) === _stepsSnapshot;
  }
  // Only fields showing a CURRENT value are tracked. Effective date and source
  // describe this submission rather than the department, so they stay blank and
  // are read normally — prefilling the old effective date would let a new figure
  // inherit a stale date while still satisfying the "date required" check.
  function markDirty(id) { if (id) _dirty[id] = true; }
  function isDirty(id) { return !!_dirty[id]; }
  // What preset() put in each field, so an edit can be judged by VALUE and not
  // merely by whether the field was typed in.
  var _prefilled = {};
  // Digits, thousands separators, one decimal point, an optional $ — the shape
  // of a money/hours field. Deliberately strict: a schedule like "24/48" must
  // NOT qualify, because parseMoney("24/48") is 24 and parseMoney("24/72") is
  // also 24, which would call two different schedules identical.
  var NUMERIC_TEXT = /^[$\s]*\d[\d,]*(\.\d+)?[$\s]*$/;
  // Is the field showing exactly what was prefilled? Keystroke tracking alone
  // said no: retyping the figure already on file marked the field dirty, and the
  // value published as a fresh report — joining the consensus cluster, adding a
  // distinct contributor toward "Strong community agreement", and resetting the
  // department's freshness date, all without telling anyone anything new. It
  // also demanded a new effective date for a figure that had not moved. Numbers
  // are compared numerically so "76,208", "76208" and "76208.00" are one answer.
  function unchangedFromPrefill(id) {
    if (!Object.prototype.hasOwnProperty.call(_prefilled, id)) return false;
    var before = String(_prefilled[id]).trim(), now = String(v(id)).trim();
    if (before === now) return true;
    if (!NUMERIC_TEXT.test(before) || !NUMERIC_TEXT.test(now)) return false;
    var a = Lib.parseMoney(before), b = Lib.parseMoney(now);
    return a != null && b != null && a === b;
  }
  // The submitted value of a prefilled field: empty unless the contributor
  // actually changed it, so gather() and validateStep() see only real edits.
  function dv(id) { return (isDirty(id) && !unchangedFromPrefill(id)) ? v(id) : ''; }
  // Sets a field's displayed value WITHOUT marking it dirty.
  function preset(id, val) {
    var el = document.getElementById(id);
    if (!el || val == null || val === '') return;
    // Never overwrite something the contributor typed. Prefill re-runs when they
    // switch departments in step 1, and their own work outranks any prefill.
    if (isDirty(id)) return;
    el.value = String(val);
    _prefilled[id] = String(val);
    el.classList.add('prefilled');
  }

  // Free-text box that appears when a schedule dropdown is set to "Other".
  function customSchedInput(id) {
    return '<input type="text" id="' + id + '-custom" class="sched-custom" hidden maxlength="80" ' +
      'placeholder="Describe it — e.g. Modified 24-hour (24 on/72 off; 48 on/72 off)" ' +
      'aria-label="Describe the shift schedule">';
  }
  // The schedule as it should be PUBLISHED: the typed description when "Other"
  // is selected, otherwise the picked value. Never the literal token 'other',
  // which would show up on the page as a schedule named "other".
  function schedVal(id) {
    // Value-aware, not keystroke-aware: a prefilled schedule the contributor
    // never touched — or retyped identically — is not a change, and
    // republishing it would show up in history as one.
    var changed = (isDirty(id) && !unchangedFromPrefill(id)) ||
                  (isDirty(id + '-custom') && !unchangedFromPrefill(id + '-custom'));
    return changed ? schedShown(id) : '';
  }
  // The schedule as DISPLAYED, touched or not. schedVal() answers "what should
  // be published"; this answers "what does this department work", which is what
  // the maths below needs.
  function schedShown(id) {
    var picked = v(id);
    return picked === 'other' ? v(id + '-custom') : picked;
  }
  // Hours for ARITHMETIC, which is a different question from which hours to
  // PUBLISH. Annualizing an hourly rate needs the department's real scheduled
  // hours, and a prefilled box the contributor never touched still holds that
  // real figure — reading it with dv() (which returns '' for anything untouched)
  // fell through to the 2,912-hour assumption instead, publishing $25.00/hr on a
  // 24/72 department as $72,800/yr rather than $54,600: a third too high, with
  // nothing on screen to show it had happened. So the maths reads what is
  // displayed, then the schedule's standard hours; dv() still governs what gets
  // submitted as a change.
  function hoursForMath(hoursId, schedId) {
    return Lib.parseNumber(v(hoursId)) || Lib.scheduleHours(schedShown(schedId)) || null;
  }
  // Reveals/hides the companion box and keeps stale text from being published
  // if the contributor changes their mind back to a listed schedule.
  function wireSchedule(id) {
    var sel = document.getElementById(id), box = document.getElementById(id + '-custom');
    if (!sel || !box) return;
    var sync = function () {
      box.hidden = sel.value !== 'other';
      if (box.hidden) box.value = '';
    };
    sel.addEventListener('change', sync);
    sync();
  }
  // Reformats on every keystroke; Lib.formatMoneyInput is what keeps a
  // part-typed decimal ("25.", "25.50") intact instead of collapsing it into
  // 2,550. Caret is restored to the end only when the value actually changed,
  // so arrowing back into the middle of a number to edit it still works.
  function commaFmt(el) {
    var before = el.value;
    var after = Lib.formatMoneyInput(before);
    if (after === before) return;
    var atEnd = el.selectionStart === before.length;
    el.value = after;
    if (atEnd && el.setSelectionRange) { try { el.setSelectionRange(after.length, after.length); } catch (e) {} }
  }

  // ── Wizard shell ──────────────────────────────────────────────────────────────
  var STEP_LABELS = ['Department', 'Compensation', 'Source', 'Review'];
  // Steps already completed are real buttons — going back is always safe (state
  // survives) and reaching step 1 from review otherwise took three Back clicks.
  // Steps not yet reached stay inert, since jumping forward would skip validation.
  function indicator() {
    return '<div class="wiz-steps">' + STEP_LABELS.map(function (lab, i) {
      var n = i + 1, done = n < st.step, cls = n === st.step ? 'active' : (done ? 'done' : '');
      var inner = '<span class="dot">' + (done ? '✓' : n) + '</span><span class="lab">' + lab + '</span>';
      if (done) {
        return '<button type="button" class="wiz-step ' + cls + '" data-goto="' + n + '" title="Back to ' + lab + '">' + inner + '</button>';
      }
      return '<div class="wiz-step ' + cls + '"' + (n === st.step ? ' aria-current="step"' : '') + '>' + inner + '</div>';
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
    var ind = document.getElementById('wiz-indicator');
    if (ind) {
      ind.innerHTML = indicator();
      ind.querySelectorAll('[data-goto]').forEach(function (b) {
        b.onclick = function () { goStep(parseInt(b.getAttribute('data-goto'), 10)); };
      });
    }
    var navc = document.getElementById('wiz-nav-c'); if (navc) navc.innerHTML = nav();
    document.querySelectorAll('.wiz-panel').forEach(function (p) { p.style.display = (parseInt(p.getAttribute('data-step'), 10) === st.step) ? '' : 'none'; });
    if (st.step === 4) { var rp = document.getElementById('panel-review'); if (rp) rp.innerHTML = step4(); }
    wireNav();
  }

  function goStep(n) {
    st.step = n;
    _pendingWarnStep = null; // a fresh arrival at any step should show its warnings again, not auto-skip them
    var s = document.getElementById('form-status'); if (s) s.innerHTML = '';
    updateChrome();
    var top = document.querySelector('main'); if (top) window.scrollTo({ top: top.offsetTop, behavior: 'smooth' });
  }
  function wireNav() {
    var back = document.getElementById('wiz-back'); if (back) back.onclick = function () { goStep(st.step - 1); };
    // validateStep() returns false (hard block, message shown by fail()), true
    // (clean, advance immediately), or 'warn' (non-blocking — show the message
    // and require a second click on the SAME step to actually confirm past it,
    // instead of the warning flashing and being wiped by goStep() on the same
    // click that triggered it).
    var next = document.getElementById('wiz-next'); if (next) next.onclick = function () {
      var result = validateStep();
      if (result === false) { _pendingWarnStep = null; _pendingWarnMsg = null; return; }
      if (result === 'warn') {
        var shown = (document.getElementById('form-status') || {}).textContent || '';
        if (_pendingWarnStep !== st.step || _pendingWarnMsg !== shown) {
          _pendingWarnStep = st.step; _pendingWarnMsg = shown;
          return;
        }
      }
      _pendingWarnStep = null; _pendingWarnMsg = null;
      goStep(st.step + 1);
    };
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
          field('ZIP *', '<input id="f-zip" type="text" inputmode="numeric" maxlength="5"><span id="f-zip-resolved" class="field-hint" style="display:block;margin-top:.25rem"></span>', 'Required — this is how we place the department on the map.', 'f-zip') +
          // No pre-selected default: "Municipal" silently became the answer for
          // anyone who skipped the field, asserting a fact nobody stated.
          field('Type', selP('f-dtype', [['municipal', 'Municipal'], ['esd', 'Emergency services district'], ['county', 'County'], ['university', 'University'], ['airport', 'Airport'], ['fire-rescue-district', 'Fire-rescue district'], ['combination', 'Combination'], ['other', 'Other']], 'Select type…'), null, 'f-dtype') + '</div>' +
        field('Website or careers URL', '<input id="f-web" type="url" placeholder="https://">', null, 'f-web');
    }
    // Same live-search dropdown as the homepage's "Find a department" box —
    // suggestions with city and entry pay, keyboard navigation, and an explicit
    // pick. The old <datalist> opened a browser dropdown of all 56 departments
    // and resolved free text by loose substring, so the selection flapped
    // between departments while the contributor was still typing.
    return '<h2>Which department?</h2>' + typeToggle +
      field('Search for a department',
        '<div class="searchbox" style="max-width:none">' +
          '<span class="search-icon" aria-hidden="true">⌕</span>' +
          '<input id="f-dept-search" type="search" autocomplete="off" placeholder="Type a department, city, or county…">' +
          '<div class="search-results" id="dept-search-results" role="listbox" aria-label="Matching departments"></div>' +
        '</div>',
        'Start typing — ' + D.all().length + ' departments listed.', 'f-dept-search') +
      '<div id="current-values"></div>';
  }

  function currentValuesCard(dept) {
    var s = dept.summary || {};
    if (!s.hasSalary) return '<div class="notice info" style="margin-top:.5rem"><span class="notice-icon">ℹ</span><div><strong>' + UI.esc(dept.name) + '</strong> has no salary on file yet — anything you add will be its first report.</div></div>';
    var row = function (k, val) { return '<div class="cv-row"><span>' + k + '</span><strong>' + val + '</strong></div>'; };
    return '<div class="card card-tight cv-card" style="margin-top:.75rem"><div class="cv-title">Current values for ' + UI.esc(dept.name) + '</div>' +
      row('Entry pay', UI.money(s.entry)) + row('Top pay', s.topBase ? UI.money(s.topBase) : '—') +
      // Same rule js/compare.js uses: a single-rate department derives 0 years
      // only because one step is on file, so showing "0 yr" here would tell a
      // contributor the progression is known when it is exactly what is missing.
      row('Years to top', (s.singleRatePlan || s.yearsToTop == null) ? '—' : s.yearsToTop + ' yr') + row('Schedule', UI.esc(dept.scheduleType || '—')) +
      // From the derived summary, so the contributor is shown the date actually
      // in force rather than whatever the seed record was imported with.
      row('Effective date', fmtDate(s.effectiveDate) || '—') +
      '<p class="field-hint" style="margin:.5rem 0 0">Only fill in what you’re changing on the next step.</p></div>';
  }

  // ── Step 2 ─────────────────────────────────────────────────────────────────────
  function step2() {
    var intro = st.type === 'add'
      ? '<h2>Compensation (optional)</h2><p class="muted">Add starting pay for ' + UI.esc(deptName()) + ' now, or skip and let the community fill it in.</p>'
      : '<h2>What are you changing?</h2><p class="muted">Showing what ' + UI.esc(deptName()) +
        ' currently has on file — <strong>edit only what’s different</strong>. Anything you leave as-is isn’t submitted, so it won’t be recorded as a change or counted as a fresh report.</p>';
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
      supplementalSection() +
      departmentFactsSection();
  }

  // A department-level fact, not a pay figure — asked once per submission
  // regardless of mode, folded into whichever department this submission is
  // for. Optional and tri-state: leaving it "Not sure" omits it entirely
  // rather than asserting a value, so it never overwrites a known answer with
  // a guess.
  function departmentFactsSection() {
    return '<div class="divider-label">Department facts (optional)</div>' +
      field('Civil service?', sel('c-civil', [['', 'Not sure / skip'], ['yes', 'Yes — civil service'], ['no', 'No — not civil service']], ''),
        'Whether hiring/promotion follows a civil service system (exam-based, commission-governed).', 'c-civil');
  }

  // A single flat rate — no raise by tenure. Sets BOTH entry and top pay to the
  // same figure, distinct from only knowing (not lacking) one point of a scale.
  function singleFields() {
    return '' +
      '<div class="grid cols-2">' +
        field('Pay amount', money('c-flat-amount', '$'), 'One flat rate — no raise by tenure. Sets both entry and top pay to this figure.', 'c-flat-amount') +
        field('Pay period', sel('c-flat-period', PERIODS, 'annual'), null, 'c-flat-period') +
      '</div>' +
      '<div class="grid cols-3">' +
        field('Amount represents', sel('c-flat-basis', BASIS, 'base'), null, 'c-flat-basis') +
        field('Effective date', dateI('c-flat-eff'), null, 'c-flat-eff') +
        field('Shift schedule', sel('c-flat-sched', SCHEDULES, '') + customSchedInput('c-flat-sched'), null, 'c-flat-sched') +
      '</div>' +
      field('Scheduled annual hours', numI('c-flat-hours', '2912'), null, 'c-flat-hours') +
      field('Recruit / academy pay (optional)', money('c-flat-recruit', '$'), 'Pay during the academy, before graduating to Firefighter — kept separate from the figure above. Leave blank if not applicable.', 'c-flat-recruit');
  }

  // Entry, midpoint, and/or top pay — a common 3-point pay scale, entered together
  // as one submission. Unlike the flat-rate tab, leaving one blank means "unknown",
  // not "same as the others".
  function rangeFields() {
    return '' +
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
        field('Shift schedule', sel('c-sched', SCHEDULES, '') + customSchedInput('c-sched'), null, 'c-sched') +
        field('Scheduled annual hours', numI('c-hours', '2912'), null, 'c-hours') +
      '</div>' +
      field('Recruit / academy pay (optional)', money('c-recruit', '$'), 'Pay during the academy, before graduating to Firefighter — kept separate from the Firefighter scale above. Leave blank if not applicable.', 'c-recruit');
  }

  function planFields() {
    return '' +
      '<div class="grid cols-2">' +
        field('Effective date', dateI('p-eff'), null, 'p-eff') +
        field('Pay period', sel('p-period', PLAN_PERIODS, 'annual'), 'Sets the unit for every dollar figure in the steps below — switch to “Per hour” if you’re entering hourly rates, not annual salaries.', 'p-period') +
      '</div>' +
      '<div class="grid cols-2">' +
        field('Shift schedule', sel('p-sched', SCHEDULES, '') + customSchedInput('p-sched'), null, 'p-sched') +
        field('Scheduled annual hours', numI('p-hours', '2912'), null, 'p-hours') +
      '</div>' +
      field('Recruit / academy pay (optional)', money('p-recruit', '$'), 'Pay during the academy, before graduating to Firefighter — kept separate from the step plan below. The steps below should still start at the first Firefighter step, not the academy rate.', 'p-recruit') +
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
      // Departments carry pay the fixed list can't name (hazmat stipend, dive
      // team, tiller pay...). Without somewhere to say what it is, "Other" would
      // publish as an unexplained amount, which is worse than not collecting it.
      '<input type="text" class="s-label" hidden placeholder="Name this pay item — e.g. Hazmat team stipend" aria-label="Name of the other pay item">' +
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
    var hours = hoursForMath('p-hours', 'p-sched');
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
    // NEW-side money: exactly the figure that will be recorded. Typed cents stay
    // visible — $98,500.75 must not review as "$98,501" (and a $2.50/hr add-on
    // must not review as "$3/hr"). Old-side values keep UI.money, mirroring what
    // the site currently displays.
    var mx = function (n) {
      return (n % 1)
        ? '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : UI.money(n);
    };
    // The OLD side is escaped here, not at each call site: it carries the
    // department's current shift schedule, which is contributor-supplied free
    // text. Every caller already escapes the new side.
    var arrow = function (k, o, nw) { return '<div class="rv-row"><span class="rv-k">' + k + '</span><span class="rv-old">' + (o != null ? UI.esc(o) : '—') + '</span><span class="rv-arw">→</span><span class="rv-new">' + nw + '</span></div>'; };

    if (st.type === 'add') rows.push(kv('New department', UI.esc(payload.name || '(unnamed)') + ' · ' + UI.esc(payload.city || '')));
    else rows.push(kv('Department', UI.esc(dept ? dept.name : st.dept)));

    if (payload.mode === 'plan') {
      var pl = payload.plan || {};
      rows.push(kv('Number of steps', (pv.steps || []).length));
      rows.push(arrow('Entry pay', cur.entry != null ? UI.money(cur.entry) : null, pv.entry != null ? mx(pv.entry) : '—'));
      rows.push(arrow('Top pay', cur.topBase != null ? UI.money(cur.topBase) : null, pv.top != null ? mx(pv.top) : '—'));
      if (pv.recruit != null) rows.push(arrow('Recruit / academy pay', cur.recruit != null ? UI.money(cur.recruit) : null, mx(pv.recruit)));
      if (pl.yearsToTop != null) rows.push(kv('Years to top', pl.yearsToTop + ' yr'));
    } else if (pv.entry != null || pv.midpoint != null || pv.top != null || pv.reportedEntry != null || pv.reportedMidpoint != null || pv.reportedTop != null || pv.recruit != null) {
      var isTotal = pv.basis === 'total';
      var posLabel = 'Firefighter — ' + periodLabel(pv.payPeriod);
      if (pv.recruit != null) rows.push(arrow('Recruit / academy pay', cur.recruit != null ? UI.money(cur.recruit) : null, mx(pv.recruit) + ' — ' + periodLabel(pv.payPeriod)));
      // Entry/midpoint/top each get their own row, compared against the matching
      // career point AND the matching kind of figure — a midpoint amount is never
      // diffed against entry or top, and a "reported total compensation" amount is
      // never diffed against base pay.
      var newEntry = pv.entry != null ? pv.entry : pv.reportedEntry;
      if (newEntry != null) {
        var oldEntry = isTotal ? cur.reportedEntry : cur.entry;
        rows.push(arrow(posLabel + ' (entry)', oldEntry != null ? UI.money(oldEntry) : null, mx(newEntry) + basisSuffix(pv.basis)));
      }
      var newMid = pv.midpoint != null ? pv.midpoint : pv.reportedMidpoint;
      if (newMid != null) {
        var oldMid = isTotal ? cur.reportedMidpoint : cur.midpoint;
        rows.push(arrow(posLabel + ' (midpoint)', oldMid != null ? UI.money(oldMid) : null, mx(newMid) + basisSuffix(pv.basis)));
      }
      var newTop = pv.top != null ? pv.top : pv.reportedTop;
      if (newTop != null) {
        var oldTop = isTotal ? cur.reportedTop : cur.topBase;
        rows.push(arrow(posLabel + ' (top)', oldTop != null ? UI.money(oldTop) : null, mx(newTop) + basisSuffix(pv.basis)));
      }
    }

    // Working conditions and department facts, shown in EVERY mode rather than
    // inside whichever pay branch happened to run. Each of these is a publishable
    // change on its own: a submission correcting only the scheduled annual hours,
    // or only answering the civil-service question, reached this screen listing
    // nothing but the department name and then published anyway — the contributor
    // had no way to confirm what they were about to send.
    var wc = payload.mode === 'plan' ? (payload.plan || {}) : pv;
    if (wc.effectiveDate) rows.push(arrow('Effective date', fmtDate(cur.effectiveDate) || null, UI.esc(fmtDate(wc.effectiveDate))));
    if (wc.schedule) rows.push(arrow('Schedule', dept ? (dept.scheduleType || null) : null, UI.esc(wc.schedule)));
    if (wc.hoursAnnual) rows.push(arrow('Scheduled annual hours', dept ? (dept.annualScheduledHours || null) : null, UI.esc(wc.hoursAnnual)));
    if (payload.civilService != null) {
      rows.push(arrow('Civil service', dept && dept.civilService != null ? (dept.civilService ? 'Yes' : 'No') : null,
        payload.civilService ? 'Yes' : 'No'));
    }

    // A percentage is not a dollar amount — "$10/% base" was nonsense.
    (pv.supplemental || []).forEach(function (s) {
      if (s.removed) {
        rows.push(kv(UI.esc(Lib.supplementalLabel(s.type, s.label)),
          '<span class="rv-old">Removed from this department</span>'));
        return;
      }
      var shown = s.unit === 'pct' ? (s.amount + '% of base') : (mx(s.amount) + '/' + unitLabel(s.unit));
      rows.push(kv(UI.esc(Lib.supplementalLabel(s.type, s.label)), shown));
    });
    // readSupp() silently drops a row missing either half, so a contributor who
    // picked "Longevity pay" and forgot the amount would see it simply not
    // appear here with no explanation.
    var halfFilled = countHalfFilledSupp();
    if (halfFilled) {
      rows.push(kv('Incomplete pay item' + (halfFilled > 1 ? 's' : ''),
        '<span class="rv-old" style="text-decoration:none">' + halfFilled + ' skipped — needs both a type and an amount</span>'));
    }

    var stepsList = '';
    if (payload.mode === 'plan' && (pv.steps || []).length) {
      stepsList = '<div class="rv-steps"><div class="rv-steps-title">Steps</div>' + pv.steps.map(function (s) {
        return '<div class="rv-step"><span>' + UI.esc(s.label || '—') + (s.isTopStep ? ' · top' : '') + '</span><span>' + Math.round((s.startMonths || 0) / 12 * 10) / 10 + ' yr</span><span>' + mx(s.basePay) + '</span></div>';
      }).join('') + '</div>';
    }

    var prov = payload.sourceType;
    rows.push('<div class="rv-row"><span class="rv-k">Source</span><span class="rv-new">' + (prov ? UI.esc(provLabel(prov)) : 'Not specified') + ' · ' + (payload.sourceStatus === 'sourced' ? '<span class="chip strong" style="padding:1px 8px">Sourced</span>' : '<span class="chip reported" style="padding:1px 8px">Provisional</span>') + '</span></div>');

    if (rows.length <= 1) return '<div class="notice warn"><span class="notice-icon">⚠</span><div>No changes yet — go back and enter at least one figure.</div></div>';
    return '<div class="review-card">' + rows.join('') + '</div>' + stepsList;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────────
  function wireStep() {
    // type toggle — a full re-render, so everything typed on steps 2-3 (and any
    // attached file) is discarded. Back-navigation preserves state, so people
    // reasonably assume this does too; confirm before throwing the work away.
    document.querySelectorAll('#type-seg [data-type]').forEach(function (b) {
      b.onclick = function () {
        var next = b.getAttribute('data-type');
        if (next === st.type) return;
        if (hasEnteredWork() && !window.confirm('Switching between "Update a department" and "Add a new department" clears the pay details you have entered. Switch anyway?')) return;
        st.type = next; st.step = 1; st.steps = []; render();
      };
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

    // top-level money fields (single + range modes; plan-level recruit pay)
    document.querySelectorAll('#mode-single input.money, #mode-range input.money').forEach(function (el) { el.addEventListener('input', function () { commaFmt(el); }); });
    var pr = document.getElementById('p-recruit'); if (pr) pr.addEventListener('input', function () { commaFmt(pr); });
    ['c-flat-sched', 'c-sched', 'p-sched'].forEach(wireSchedule);

    var zipBox = document.getElementById('f-zip');
    if (zipBox) {
      ['input', 'change'].forEach(function (ev) { zipBox.addEventListener(ev, renderZipResolved); });
      var cityBox = document.getElementById('f-city');
      if (cityBox) ['input', 'change'].forEach(function (ev) { cityBox.addEventListener(ev, renderZipResolved); });
      renderZipResolved();
    }

    // dept search — live suggestion dropdown; the department is set ONLY by an
    // explicit pick (click/Enter) or by text that exactly equals a listed
    // "Name — City" (which is what a ?dept= deep link puts in the box). Loose
    // substring matching mid-typing is exactly what made the old picker flap.
    var ds = document.getElementById('f-dept-search');
    var dsResults = document.getElementById('dept-search-results');
    if (ds && dsResults) {
      if (st.dept) { var d0 = D.get(st.dept); if (d0) ds.value = d0.name + ' — ' + d0.city; }
      renderCurrent();
      var dsActive = -1;
      var applyDept = function (next) {
        if (next === st.dept) return;
        st.dept = next;
        renderCurrent();
        // Step 2 is built once and merely hidden, so its prefill has to be
        // refreshed here rather than only on the initial render. Without this,
        // everyone who reached the form without a ?dept= link — which is the
        // whole submit.html nav path, as opposed to the button on a department
        // page — met empty boxes under a heading promising "showing what X
        // currently has on file", and no way to see what they were changing.
        clearPrefills();
        prefillCurrentValues();
        if (st.mode === 'plan' && !st.steps.length) st.steps.push(blankStep(0, 'Entry'));
        renderEditor();
      };
      var closeResults = function () { dsResults.classList.remove('open'); dsResults.innerHTML = ''; dsActive = -1; };
      var pick = function (slug) {
        var d = D.get(slug);
        if (!d) return;
        ds.value = d.name + ' — ' + d.city;
        closeResults();
        applyDept(slug);
      };
      var renderResults = function (list, q) {
        dsActive = -1;
        if (!list.length) {
          if (!q) { closeResults(); return; }
          // The same dead-end-to-contribution turn the homepage search makes,
          // except here "add it" is one click away on this very page.
          dsResults.innerHTML = '<div class="search-empty"><p><strong>' + UI.esc(q) + '</strong> isn’t in the database yet.</p>' +
            '<button type="button" class="btn btn-outline btn-sm" id="ds-switch-add">Add it as a new department →</button></div>';
          dsResults.classList.add('open');
          var sw = document.getElementById('ds-switch-add');
          if (sw) sw.addEventListener('click', function () {
            var addBtn = document.querySelector('#type-seg [data-type="add"]');
            if (addBtn) addBtn.click();
          });
          return;
        }
        dsResults.innerHTML = list.map(function (d) {
          var s = d.summary || {};
          return '<button type="button" role="option" data-slug="' + UI.esc(d.slug) + '"><span>' + UI.esc(d.name) +
            '</span><span class="r-loc">' + UI.esc(d.city) + ', ' + UI.esc(d.county) + ' Co. · ' +
            (s.hasSalary ? UI.money(s.entry) + ' entry' : 'needs data') + '</span></button>';
        }).join('');
        dsResults.classList.add('open');
      };
      ds.addEventListener('input', function () {
        var q = ds.value.trim();
        var exact = D.all().find(function (d) { return (d.name + ' — ' + d.city).toLowerCase() === q.toLowerCase(); });
        if (exact) applyDept(exact.slug);
        else if (st.dept) applyDept('');
        renderResults(exact || !q ? [] : window.FireData.search(q), q);
      });
      dsResults.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-slug]');
        if (b) pick(b.getAttribute('data-slug'));
      });
      ds.addEventListener('keydown', function (e) {
        var opts = Array.prototype.slice.call(dsResults.querySelectorAll('button[data-slug]'));
        if (!opts.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); dsActive = Math.min(dsActive + 1, opts.length - 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); dsActive = Math.max(dsActive - 1, 0); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (dsActive >= 0) pick(opts[dsActive].getAttribute('data-slug'));
          else if (opts.length === 1) pick(opts[0].getAttribute('data-slug'));
          return;
        } else if (e.key === 'Escape') { closeResults(); return; }
        else return;
        opts.forEach(function (o, i) { o.classList.toggle('active', i === dsActive); });
      });
      document.addEventListener('click', function (e) {
        if (!dsResults.contains(e.target) && e.target !== ds) closeResults();
      });
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
    if (addSupp) { var supp = document.getElementById('supp-rows'); addSupp.onclick = function () { supp.insertAdjacentHTML('beforeend', suppRow()); rewireMoney(supp); rewireSuppRemove(supp); rewireSuppType(supp); }; }

    // file upload
    var file = document.getElementById('src-file');
    if (file) file.addEventListener('change', function () { acceptFile(file.files && file.files[0]); });
    wireDropZone(file);

    // One delegated listener rather than per-field wiring: the step-2 panel is
    // re-rendered and re-populated in several places, and anything that misses a
    // field would make a real edit look untouched and silently drop it.
    var form = document.getElementById('the-form');
    if (form && !form._dirtyWired) {
      form._dirtyWired = true;
      ['input', 'change'].forEach(function (ev) {
        form.addEventListener(ev, function (e) {
          var el = e.target;
          if (!el || !el.id) return;
          markDirty(el.id);
          el.classList.remove('prefilled');
        });
      });
    }
    prefillCurrentValues();
  }

  // Populates step 2 with what the department currently shows. Update flow only:
  // there is nothing to compare against when adding a department, and a
  // prefilled figure there would be pure invention.
  function prefillCurrentValues() {
    if (st.type !== 'update' || !st.dept) return;
    var d = D.get(st.dept);
    if (!d) return;
    var s = d.summary || {};
    // Whole dollars, like every figure the site displays — a stored 101592.45
    // prefilled as "101,592.45" next to an entry showing "97,529" read as two
    // different kinds of number. Rounding only changes what the eye sees:
    // dv() keeps an untouched field out of the submission either way, and a
    // contributor who edits the field asserts their own figure.
    var money = function (n) { return n == null ? '' : Lib.formatMoneyInput(String(Math.round(n))); };

    // Single mode shows one flat rate; entry is the honest starting point since
    // that is the figure a flat rate would replace.
    preset('c-flat-amount', money(s.entry));
    preset('c-flat-recruit', money(s.recruit));
    preset('c-entry', money(s.entry));
    preset('c-midpoint', money(s.midpoint));
    preset('c-top', money(s.topBase));
    preset('c-recruit', money(s.recruit));
    preset('p-recruit', money(s.recruit));

    ['c-flat-hours', 'c-hours', 'p-hours'].forEach(function (id) {
      // Only a genuinely known figure — never the 2,912 assumption, which would
      // turn a guess into a reported value the moment anything else was edited.
      if (s.annualHoursKnown) preset(id, d.annualScheduledHours || s.annualHours);
    });
    ['c-flat-sched', 'c-sched', 'p-sched'].forEach(function (id) { presetSchedule(id, d.scheduleType); });
    if (d.civilService === true) preset('c-civil', 'yes');
    else if (d.civilService === false) preset('c-civil', 'no');

    prefillSteps(s);
    prefillSupplemental(s);
  }

  // The department's existing add-on pay, laid out as editable rows. Everything
  // else on this step was prefilled while these stayed blank, so correcting a
  // longevity amount meant retyping the pay type, the figure and the unit from
  // memory — and reporting a department's supplemental pay at all looked like
  // it had never been done before.
  function prefillSupplemental(s) {
    var host = document.getElementById('supp-rows');
    if (!host) return;
    var items = (s.supplemental || []).filter(function (it) { return it && it.type && it.amount != null; });
    if (!items.length) return;
    // Never displace rows the contributor is already working in.
    if (_suppPrefilled || host.querySelector('.supp-row')) return;
    host.innerHTML = items.map(function () { return suppRow(); }).join('');
    var rows = host.querySelectorAll('.supp-row');
    _suppPrefill = [];
    items.forEach(function (it, i) {
      var r = rows[i];
      if (!r) return;
      var amount = Lib.parseMoney(it.amount);
      r.querySelector('.s-type').value = it.type;
      r.querySelector('.s-amt').value = Lib.formatMoneyInput(String(amount));
      r.querySelector('.s-unit').value = it.unit || 'yr';
      var lab = r.querySelector('.s-label');
      if (it.type === 'other') { lab.hidden = false; lab.value = it.label || ''; }
      ['.s-type', '.s-amt', '.s-unit', '.s-label'].forEach(function (sel) {
        var el = r.querySelector(sel); if (el) el.classList.add('prefilled');
      });
      r.setAttribute('data-orig', rowSig(r));
      _suppPrefill.push({
        key: Lib.supplementalKey(it.type, it.type === 'other' ? it.label : ''),
        type: it.type, label: it.label || ''
      });
    });
    rewireMoney(host); rewireSuppRemove(host); rewireSuppType(host);
    // These inputs carry no id, so the form-level dirty listener skips them and
    // would leave the "existing value" styling on a figure the contributor has
    // just rewritten.
    if (!host._prefillWired) {
      host._prefillWired = true;
      ['input', 'change'].forEach(function (ev) {
        host.addEventListener(ev, function (e) {
          if (e.target && e.target.classList) e.target.classList.remove('prefilled');
        });
      });
    }
    _suppPrefilled = true;
  }

  // Prefilled items the contributor deleted from the form. Without these a
  // seeded row's ✕ would look like a delete and do nothing at all: consolidation
  // keeps the newest entry per pay type, so an item omitted from a submission
  // simply stays on the department. Matched by pay type rather than by exact
  // figure, so editing an amount reads as an edit and only a vanished row reads
  // as a removal.
  function removedSupp() {
    if (!_suppPrefill.length) return [];
    var present = {};
    document.querySelectorAll('#supp-rows .supp-row').forEach(function (r) {
      var type = (r.querySelector('.s-type') || {}).value;
      if (!type) return;
      var label = type === 'other' ? ((r.querySelector('.s-label') || {}).value || '') : '';
      present[Lib.supplementalKey(type, label)] = true;
    });
    return _suppPrefill.filter(function (it) { return !present[it.key]; }).map(function (it) {
      var o = { type: it.type, removed: true };
      if (it.type === 'other' && it.label) o.label = it.label;
      return o;
    });
  }

  // Empties the fields still showing the PREVIOUS department's figures, before
  // prefilling the newly picked one. Only untouched prefills are cleared —
  // anything the contributor typed survives a department switch, since throwing
  // away typed work without warning is exactly what the type-toggle confirm
  // dialog exists to prevent.
  function clearPrefills() {
    document.querySelectorAll('#the-form .prefilled').forEach(function (el) {
      if (el.id && isDirty(el.id)) return;
      el.value = '';
      if (el.id) delete _prefilled[el.id];
      el.classList.remove('prefilled');
    });
    ['c-flat-sched', 'c-sched', 'p-sched'].forEach(function (id) {
      var sel = document.getElementById(id), box = document.getElementById(id + '-custom');
      if (sel && box && sel.value !== 'other') { box.hidden = true; box.value = ''; }
    });
    // A seeded-but-untouched step table belongs to the old department too.
    if (!_stepsDirty) { st.steps = []; _stepsPrefilled = false; _stepsSnapshot = null; }
    // Seeded add-on rows belong to the department that was showing; drop the
    // untouched ones so the next department's are not stacked underneath.
    var suppHost = document.getElementById('supp-rows');
    if (suppHost) {
      suppHost.querySelectorAll('.supp-row').forEach(function (r) {
        if (r.getAttribute('data-orig') === rowSig(r)) r.remove();
      });
      if (!suppHost.querySelector('.supp-row')) { _suppPrefill = []; _suppPrefilled = false; }
    }
  }

  // A schedule may be one of the listed cycles or free text, so it has to land
  // in whichever control can hold it.
  function presetSchedule(id, schedule) {
    if (!schedule) return;
    var sel = document.getElementById(id);
    if (!sel) return;
    var listed = Array.prototype.some.call(sel.options, function (o) { return o.value === schedule; });
    if (listed) { preset(id, schedule); return; }
    preset(id, 'other');
    var box = document.getElementById(id + '-custom');
    if (box) { box.hidden = false; preset(id + '-custom', schedule); }
  }

  // The step editor is where "what's different?" bites hardest — retyping a
  // whole pay scale to correct one step is what makes people give up. Seeded
  // from the current plan; planSteps() still only publishes it if edited.
  function prefillSteps(s) {
    if (!(s.steps && s.steps.length)) return;
    // The editor seeds an empty "Entry" row before this runs, so testing
    // st.steps.length would always bail. What matters is whether the
    // contributor has actually put a figure in — that placeholder row is
    // exactly what the current plan should replace.
    if (_stepsDirty || st.steps.some(function (x) { return x.basePay != null; })) return;
    st.steps = s.steps.map(function (step, i) {
      return {
        id: 'k' + (_sid++),
        label: step.stepName || ('Step ' + (i + 1)),
        startMonths: step.minimumMonths != null ? step.minimumMonths : null,
        basePay: Lib.parseMoney(step.baseAnnualSalary),
        sot: Lib.parseMoney(step.scheduledOvertime),
        top: i === s.steps.length - 1
      };
    });
    _stepsPrefilled = true;
    _stepsSnapshot = stepsSignature(st.steps);
    renderEditor();
  }

  var MAX_FILE_BYTES = 10 * 1024 * 1024;
  var ACCEPTED_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'application/pdf': 1 };

  // Shared by the file picker and the drop zone so both enforce the same limits
  // the Storage rules do (10 MB, image or PDF).
  function acceptFile(f) {
    var name = document.getElementById('up-filename');
    var input = document.getElementById('src-file');
    if (!name) return;
    if (!f) { name.textContent = ''; return; }
    if (!ACCEPTED_TYPES[f.type]) {
      name.innerHTML = '<span class="field-error">That file type isn’t accepted — use a PDF, PNG or JPG.</span>';
      if (input) input.value = '';
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      name.innerHTML = '<span class="field-error">That file is over 10 MB.</span>';
      if (input) input.value = '';
      return;
    }
    name.textContent = '✓ ' + f.name;
  }

  // The upload area says "or drag a file here" but had no drop handling, so the
  // browser fell back to its default for a dropped file: navigate to it. That
  // discards every step of the form the moment someone takes the label at its
  // word. Handlers below claim the drop; the window-level pair makes a near-miss
  // (dropping just outside the box) a no-op instead of the same navigation.
  function wireDropZone(input) {
    var zone = document.querySelector('.upload-area');
    if (!zone || !input) return;
    var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { stop(e); zone.classList.add('is-dragover'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { stop(e); zone.classList.remove('is-dragover'); });
    });
    zone.addEventListener('drop', function (e) {
      stop(e);
      zone.classList.remove('is-dragover');
      var dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!dropped) return;
      // Put it on the real input so save()/uploadSourceFile() find it there.
      if (window.DataTransfer && input.files !== undefined) {
        try { var dt = new DataTransfer(); dt.items.add(dropped); input.files = dt.files; } catch (err) {}
      }
      acceptFile(dropped);
    });
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) { if (!zone.contains(e.target)) e.preventDefault(); });
    });
  }

  function onEditorInput(e) {
    var el = e.target, row = el.closest && el.closest('.plan-row'); if (!row) return;
    _stepsDirty = true;
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
    _stepsDirty = true;
    var row = b.closest('.plan-row'), i = parseInt(row.getAttribute('data-i'), 10), act = b.getAttribute('data-act');
    if (act === 'remove') st.steps.splice(i, 1);
    else if (act === 'up' && i > 0) { var t = st.steps[i - 1]; st.steps[i - 1] = st.steps[i]; st.steps[i] = t; }
    else if (act === 'down' && i < st.steps.length - 1) { var t2 = st.steps[i + 1]; st.steps[i + 1] = st.steps[i]; st.steps[i] = t2; }
    else if (act === 'dup') { var c = Object.assign({}, st.steps[i], { id: 'k' + (_sid++) }); st.steps.splice(i + 1, 0, c); }
    else if (act === 'insert') { st.steps.splice(i + 1, 0, blankStep((Number(st.steps[i].startMonths) || 0) + 12, 'Step ' + (i + 2))); }
    renderEditor();
  }

  function planControl(act) {
    _stepsDirty = true;
    if (act === 'add') st.steps.push(blankStep(nextMonths(), autoLabel()));
    else if (act === 'add5') { for (var k = 0; k < 5; k++) st.steps.push(blankStep(nextMonths(), autoLabel())); }
    else if (act === 'dup-last') { var last = st.steps[st.steps.length - 1]; if (last) st.steps.push(Object.assign({}, last, { id: 'k' + (_sid++), startMonths: (Number(last.startMonths) || 0) + 12, top: false })); }
    renderEditor();
  }

  function rewireMoney(scope) { scope.querySelectorAll('input.money').forEach(function (el) { if (el._wired) return; el._wired = true; el.addEventListener('input', function () { commaFmt(el); }); }); }
  function rewireSuppRemove(scope) { scope.querySelectorAll('.s-rm').forEach(function (b) { b.onclick = function () { b.closest('.supp-row').remove(); }; }); }
  // The free-text name only appears for "Other" — every other type already has
  // a label, and an always-visible box would read as a required field.
  function rewireSuppType(scope) {
    scope.querySelectorAll('.s-type').forEach(function (sel) {
      if (sel._wired) return;
      sel._wired = true;
      sel.addEventListener('change', function () {
        var row = sel.closest('.supp-row'); if (!row) return;
        var lab = row.querySelector('.s-label'); if (!lab) return;
        lab.hidden = sel.value !== 'other';
        if (lab.hidden) lab.value = '';
      });
    });
  }
  function renderCurrent() { var host = document.getElementById('current-values'); if (!host) return; var d = st.dept ? D.get(st.dept) : null; host.innerHTML = d ? currentValuesCard(d) : ''; }
  function deptName() { var d = D.get(st.dept); return d ? d.name : 'this department'; }

  // Has the contributor typed anything worth protecting from a destructive
  // re-render? Covers every pay field across all three modes, the step editor,
  // supplemental rows, and an attached file.
  function hasEnteredWork() {
    var ids = ['c-flat-amount', 'c-flat-recruit', 'c-flat-eff', 'c-entry', 'c-midpoint', 'c-top',
      'c-recruit', 'c-eff', 'p-eff', 'p-recruit', 'p-notes', 'src-url', 'src-prov'];
    if (ids.some(function (id) { return !!v(id); })) return true;
    if (st.steps.some(function (s) { return s.basePay != null || s.sot != null; })) return true;
    if (readSupp().length) return true;
    return hasFile();
  }

  // ── Validation ────────────────────────────────────────────────────────────────
  function validateStep() {
    var status = document.getElementById('form-status');
    function fail(msg) { if (status) status.innerHTML = notice('warn', msg); return false; }
    function warnOk(msgs) {
      if (!msgs.length) return true;
      if (status) status.innerHTML = notice('info', 'Heads up: ' + msgs.join(' ') + ' Click Continue again to proceed anyway.');
      return 'warn';
    }
    if (status) status.innerHTML = '';
    if (st.step === 1) {
      if (st.type === 'add') {
        if (!v('f-name')) return fail('Enter the department name.');
        if (!v('f-city')) return fail('Enter the city.');
        if (!v('f-county')) return fail('Enter the county.');
        if (!/^\d{5}$/.test(v('f-zip'))) return fail('Enter a valid 5-digit ZIP code — it’s how this department gets placed on the map.');
        if (v('f-web') && !Lib.safeUrl(v('f-web'))) return fail('The website must be a full link starting with http:// or https:// — or leave it blank.');
        // Both checks are non-blocking and both can be true at once, so they
        // are collected rather than returned one at a time.
        var addWarns = [];
        if (isDuplicateDept(v('f-name'), v('f-city'))) addWarns.push('This looks similar to a department already listed — if it’s the same one, use "Update a department" instead. You can still continue; an admin will double-check before it’s added to the map.');
        addWarns = addWarns.concat(locationWarning(locationProblem()));
        if (addWarns.length) return warnOk(addWarns);
      }
      // A slug from the URL (?dept=…) is trusted blindly otherwise. If it
      // matches no department, the submission publishes keyed to a slug nothing
      // reads and the report is silently discarded downstream — the same
      // dead-end as a missing slug, just harder to notice because the wizard
      // looks like it worked.
      else if (!st.dept || !D.get(st.dept)) return fail('Pick a department from the list.');
      return true;
    }
    if (st.step === 3) {
      if (v('src-url') && !Lib.safeUrl(v('src-url'))) return fail('The source link must be a full link starting with http:// or https:// — or leave it blank.');
      return true;
    }
    if (st.step === 2) {
      var supp = readSupp().concat(removedSupp());
      // Civil service is a real, publishable change — extractCivilService reads
      // it and it drives a directory filter — so it counts toward "did you
      // change anything", same as a schedule or an effective date.
      var civilAnswered = !!dv('c-civil');
      if (supp.find(function (s) { return s.amount < 0; })) return fail('Supplemental pay can’t be negative.');
      if (unnamedOtherSupp(supp)) return fail('Name the “Other” pay item so people know what it is — e.g. “Hazmat team stipend”.');
      // Plan mode keeps its own blocking checks first — a half-filled step table
      // is a hard error, not something to warn past.
      if (st.mode === 'plan') return validatePlan(fail, warnOk, supp);
      if (st.mode === 'range') {
        var entryAmt = Lib.parseMoney(dv('c-entry')), midAmt = Lib.parseMoney(dv('c-midpoint')), topAmt = Lib.parseMoney(dv('c-top'));
        var rRecruitAmt = Lib.parseMoney(dv('c-recruit'));
        var anyAmt = entryAmt != null || midAmt != null || topAmt != null || rRecruitAmt != null;
        // schedVal() is dirty-aware; plain v() would read the PREFILLED schedule and
        // treat an untouched form as though something had been changed.
        if (st.type === 'update' && !anyAmt && !supp.length && !civilAnswered && !schedVal('c-sched') && !dv('c-hours') && !v('c-eff')) return fail('Nothing changed yet — edit whichever figures are different, then continue.');
        if (anyAmt) {
          if ((entryAmt != null && entryAmt < 0) || (midAmt != null && midAmt < 0) || (topAmt != null && topAmt < 0) || (rRecruitAmt != null && rRecruitAmt < 0)) return fail('Pay amounts can’t be negative.');
          if (!v('c-basis')) return fail('Choose what these amounts represent (base, base+OT, or total).');
          if (!v('c-eff')) return fail('Add an effective date for these pay amounts.');
        }
        var rSched = scheduleProblems('c-sched', 'c-hours', fail);
        if (rSched.blocked !== undefined) return rSched.blocked;
        // Annualized before the plausibility check — a $25.50 hourly rate is
        // perfectly normal and must not trip the "unusually low" warning.
        var rAnn = function (x) { return toAnnual(x, v('c-period'), hoursForMath('c-hours', 'c-sched')); };
        return warnOk(rSched.warns.concat(noPayWarnings(anyAmt, supp)).concat(figureWarnings([
          ['entry', rAnn(entryAmt)], ['midpoint', rAnn(midAmt)], ['top', rAnn(topAmt)]
        ])));
      }
      // single (flat rate) mode
      var flatAmt = Lib.parseMoney(dv('c-flat-amount'));
      var flatRecruitAmt = Lib.parseMoney(dv('c-flat-recruit'));
      if (st.type === 'update' && flatAmt == null && flatRecruitAmt == null && !supp.length && !civilAnswered && !schedVal('c-flat-sched') && !dv('c-flat-hours') && !v('c-flat-eff')) return fail('Nothing changed yet — edit whichever figures are different, then continue.');
      if (flatAmt != null || flatRecruitAmt != null) {
        if ((flatAmt != null && flatAmt < 0) || (flatRecruitAmt != null && flatRecruitAmt < 0)) return fail('Pay amounts can’t be negative.');
        if (!v('c-flat-basis')) return fail('Choose what the amount represents (base, base+OT, or total).');
        if (!v('c-flat-eff')) return fail('Add an effective date for the pay amount.');
      }
      var fSched = scheduleProblems('c-flat-sched', 'c-flat-hours', fail);
      if (fSched.blocked !== undefined) return fSched.blocked;
      return warnOk(fSched.warns
        .concat(flatRateWarnings(flatAmt))
        .concat(noPayWarnings(flatAmt != null || flatRecruitAmt != null, supp))
        .concat(figureWarnings([['flat rate', toAnnual(flatAmt, v('c-flat-period'), hoursForMath('c-flat-hours', 'c-flat-sched'))]])));
    }
    return true;
  }

  // Plan mode has warned about decreasing steps and implausible figures since it
  // shipped; single/range had nothing equivalent, so the only backstop was
  // computeAutomatedFlags AFTER submission, which routes the whole thing to the
  // admin queue instead of letting the contributor catch a typo in place.
  // Non-blocking, like every other warning here — one more click proceeds.
  function figureWarnings(pairs) {
    var warns = [];
    var got = {};
    pairs.forEach(function (p) { if (p[1] != null) got[p[0]] = p[1]; });
    // Career points must not run backwards. Only compare pairs actually given —
    // a blank midpoint means "unknown", never "zero".
    if (got.entry != null && got.top != null && got.entry > got.top) {
      warns.push('entry pay is higher than top pay — check they aren’t swapped.');
    }
    if (got.midpoint != null && got.entry != null && got.midpoint < got.entry) {
      warns.push('midpoint pay is below entry pay.');
    }
    if (got.midpoint != null && got.top != null && got.midpoint > got.top) {
      warns.push('midpoint pay is above top pay.');
    }
    var vals = Object.keys(got).map(function (k) { return got[k]; });
    if (vals.some(function (n) { return n > Lib.FLAG_MAX_REASONABLE; })) {
      warns.push('a figure looks unusually high — double-check the amount and the pay period.');
    }
    if (vals.some(function (n) { return n > 0 && n < Lib.FLAG_MIN_REASONABLE; })) {
      warns.push('a figure looks unusually low for an annual salary — if you meant an hourly or monthly rate, set “Pay period” to match.');
    }
    return warns;
  }

  // Single mode publishes one figure as BOTH entry and top pay. For a department
  // that already shows a real range that is a destructive edit, not a correction
  // — and the review diff's separate entry and top rows are easy to skim past.
  // Updates now default to Entry/Midpoint/Top so nobody lands here by accident,
  // but anyone who deliberately switches to the flat-rate tab gets told what it
  // is about to do to the top pay on file. Non-blocking: a department really can
  // move to a single rate, and this is a warning, not a veto.
  function flatRateWarnings(amount, remedy) {
    if (amount == null || st.type !== 'update') return [];
    var cur = (D.get(st.dept) || {}).summary || {};
    if (cur.entry == null || cur.topBase == null || cur.topBase === cur.entry) return [];
    return ['a single pay figure publishes as both entry AND top pay, so this would replace the ' +
      UI.money(cur.topBase) + ' top pay on file with ' + UI.money(amount) + '. ' +
      (remedy || 'If this department pays more with tenure, go back and use "Entry / Midpoint / Top" instead.')];
  }

  // Skipping pay is a supported way to add a department ("Add starting pay now,
  // or skip and let the community fill it in"), so neither of these can block.
  // But every required-field check above sits inside `if (amount != null)`, so a
  // blank pay box passes silently -- and the department then publishes reading
  // "Salary information needed" with no hint that the one number the site exists
  // to collect is the thing that got left out. Filling in supplemental pay while
  // leaving base pay blank is the strongest signal of that mistake: nobody means
  // to report a longevity differential for a salary they never gave. One more
  // click still proceeds either way.
  // "Other" selected but nothing typed publishes a department with no usable
  // schedule at all, so this blocks. The missing-hours case only warns: a
  // contributor may genuinely not know the annual hours, and a described
  // schedule with no hours is still worth having.
  function scheduleProblems(schedId, hoursId, fail) {
    if (v(schedId) === 'other' && !v(schedId + '-custom')) {
      return { blocked: fail('Describe the shift schedule, or pick one from the list.') };
    }
    var warns = [];
    // scheduleHours() only knows the listed cycles; anything else leaves
    // js/derive.js assuming 2,912 hours, which would misstate effective hourly
    // for a department on a shorter or longer rotation.
    var sched = schedVal(schedId);
    if (sched && !Lib.scheduleHours(sched) && !Lib.parseNumber(v(hoursId))) {
      warns.push('this schedule isn’t one of the standard cycles, so scheduled annual hours are needed to work out effective hourly pay — without them the site assumes 2,912.');
    }
    return { warns: warns };
  }

  function noPayWarnings(anyBaseFigure, supp) {
    if (anyBaseFigure) return [];
    // Only meaningful when the department has no salary at all. Correcting an
    // add-on on a department that already shows base pay is an ordinary
    // contribution — and now the commonest one, since supplemental rows are
    // prefilled — so warning that it "will publish reading Salary information
    // needed" would fire on nearly every such edit and would be false.
    if (st.type === 'update' && ((D.get(st.dept) || {}).summary || {}).hasSalary) return [];
    if (supp.length) return ['you entered supplemental pay but no base salary. Supplemental amounts alone can’t be displayed as a salary, so this will still publish reading “Salary information needed”.'];
    if (st.type === 'add') return ['no pay amount was entered, so this department will publish reading “Salary information needed” until someone adds one.'];
    return [];
  }

  function validatePlan(fail, warnOk, supp) {
    var steps = st.steps;
    var meaningful = steps.filter(function (s) { return s.basePay != null || (s.label && s.label.trim()) || s.startMonths != null; });
    // A prefilled plan makes `meaningful` truthy before the contributor has
    // done anything, so an untouched editor has to count as no steps here —
    // otherwise the form advances and only fails at the very end, after they've
    // filled in a source and ticked the attestation.
    var editedSteps = !stepsUnchanged() && meaningful.length > 0;
    if (st.type === 'update' && !editedSteps && !supp.length && !dv('c-civil') && !schedVal('p-sched') && !dv('p-hours') && !dv('p-recruit')) {
      return fail(_stepsPrefilled
        ? 'Nothing changed yet — edit whichever pay steps are different, then continue.'
        : 'Add at least one pay step.');
    }
    // Add flow with no comp is allowed — but say so rather than passing silently.
    if (!meaningful.length) return warnOk(noPayWarnings(Lib.parseMoney(dv('p-recruit')) != null, supp));
    if (!v('p-eff')) return fail('Add an effective date for this pay plan.');
    var recruitAmt = Lib.parseMoney(dv('p-recruit'));
    if (recruitAmt != null && recruitAmt < 0) return fail('Recruit/academy pay can’t be negative.');
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
    var pSched = scheduleProblems('p-sched', 'p-hours', fail);
    if (pSched.blocked !== undefined) return pSched.blocked;
    warns = warns.concat(pSched.warns);
    if (v('p-sched') && v('p-sched') !== 'other' && !hoursForMath('p-hours', 'p-sched')) warns.push('a shift schedule was set without scheduled annual hours.');
    var sm = Lib.planSummary(steps.filter(function (s) { return s.basePay != null; }).map(function (s) { return { startMonths: Number(s.startMonths) || 0, basePay: s.basePay, isTopStep: !!s.top }; }));
    if (sm.top != null && (sm.top > 400000 || (sm.entry != null && sm.entry < 15000))) warns.push('some figures look unusually high or low — double-check them.');
    // A one-step "plan" is a flat rate wearing a different hat: planSummary makes
    // entry and top the same number, so it flattens a department's range exactly
    // the way the Single tab does. Same warning, different remedy.
    if (steps.length === 1) {
      warns = warns.concat(flatRateWarnings(sm.entry, 'If this department pays more with tenure, add its higher steps here too.'));
    }
    return warnOk(warns);
  }

  // ── Gather ────────────────────────────────────────────────────────────────────
  function readSupp() {
    var out = [];
    document.querySelectorAll('#supp-rows .supp-row').forEach(function (r) {
      var type = (r.querySelector('.s-type') || {}).value, amount = Lib.parseMoney((r.querySelector('.s-amt') || {}).value);
      if (!type || amount == null) return;
      // A seeded row still showing the department's own figure is not a report.
      if (r.getAttribute('data-orig') === rowSig(r)) return;
      var item = { type: type, amount: amount, unit: (r.querySelector('.s-unit') || {}).value || 'yr' };
      // Only meaningful for "Other" — carried so the page can name the item
      // instead of printing an unexplained "Other".
      var label = ((r.querySelector('.s-label') || {}).value || '').trim();
      if (type === 'other' && label) item.label = label.slice(0, 60);
      out.push(item);
    });
    return out;
  }

  // An unnamed "Other" is an amount with no meaning attached — blocking is
  // right here, unlike the softer warnings elsewhere, because there is nothing
  // a reader could do with it and nothing an admin could recover.
  function unnamedOtherSupp(supp) {
    return supp.some(function (s) { return s.type === 'other' && !s.label; });
  }

  // Rows where exactly one of {type, amount} is filled — readSupp() drops these,
  // so they're surfaced in review rather than vanishing without a word.
  function countHalfFilledSupp() {
    var n = 0;
    document.querySelectorAll('#supp-rows .supp-row').forEach(function (r) {
      var type = (r.querySelector('.s-type') || {}).value;
      var amount = Lib.parseMoney((r.querySelector('.s-amt') || {}).value);
      if ((!!type) !== (amount != null)) n++;
    });
    return n;
  }

  function planSteps() {
    // Seeded from the department's current plan and not actually altered —
    // publishing it would re-report existing steps as a fresh claim.
    if (stepsUnchanged()) return [];
    return st.steps.filter(function (s) { return s.basePay != null && s.label && s.label.trim(); }).map(function (s) {
      return { label: s.label.trim(), startMonths: Number(s.startMonths) || 0, basePay: s.basePay,
        scheduledOvertime: s.sot != null ? s.sot : null, isTopStep: !!s.top };
    });
  }

  function gather() {
    var base = { submissionType: st.type === 'add' ? 'add' : 'update', mode: st.mode,
      contributorType: (A && A.profile && A.profile.role === 'department') ? 'department' : 'community' };
    var prov = v('src-prov') || null;
    base.sourceType = prov;
    // Only a real http(s) link is stored or counted. Lib.safeUrl drops
    // javascript:/data:/etc before the value can ever reach an href, and
    // dropping non-URLs here also stops "asdf" from earning the Sourced chip.
    base.sourceUrl = Lib.safeUrl(v('src-url'));
    // An uploaded document (pay stub, plan page photo) is evidence at least as
    // strong as a pasted link — counting only the URL left a contributor who
    // attached their pay stub labeled "Provisional" at the review step.
    base.sourceStatus = ((prov && SOURCED_PROVENANCE[prov]) || base.sourceUrl || base.hasFile) ? 'sourced' : 'provisional';
    base.hasFile = hasFile();
    var civil = dv('c-civil');
    if (civil === 'yes') base.civilService = true;
    else if (civil === 'no') base.civilService = false;
    if (st.type === 'add') {
      Object.assign(base, { name: v('f-name'), city: v('f-city'), county: v('f-county'), zip: v('f-zip'), departmentType: v('f-dtype') || undefined, website: Lib.safeUrl(v('f-web')) || undefined });
      base.possibleDuplicate = isDuplicateDept(base.name, base.city);
      // Why this one needs a human to place it (see locationProblem). Absent
      // when the ZIP resolves and agrees with the city, which is the normal case.
      var loc = locationProblem();
      if (loc) {
        base.locationReview = loc.kind;
        base.zipResolvedCity = loc.zipCity || undefined;
      }
    }
    else base.departmentSlug = st.dept;

    var pv = { supplemental: readSupp().concat(removedSupp()) };
    if (st.mode === 'plan') {
      var steps = planSteps();
      var period = v('p-period');
      // Two different questions: dv() decides which hours to PUBLISH as a change,
      // hoursForMath() supplies the hours the annualizing below must use.
      var hours = Lib.parseNumber(dv('p-hours'));
      var mathHours = hoursForMath('p-hours', 'p-sched');
      base.plan = { effectiveDate: v('p-eff') || undefined,
        payPeriod: period || undefined, schedule: schedVal('p-sched') || undefined, hoursAnnual: hours || undefined, notes: v('p-notes') || undefined };
      pv.steps = steps;
      // Derive entry/top for the consensus engine — convert hourly to annual if needed.
      var sum = Lib.planSummary(steps.map(function (s) { return { startMonths: s.startMonths, basePay: s.basePay, isTopStep: s.isTopStep }; }));
      var toAnn = function (x) { return x == null ? undefined : (period === 'hourly' ? Math.round(x * (mathHours || 2912)) : x); };
      pv.entry = toAnn(sum.entry); pv.top = toAnn(sum.top);
      // Recruit/academy pay — independent of the step table (never fed into
      // entry/top/years-to-top), same period-aware annualizing as the steps.
      pv.recruit = toAnn(Lib.parseMoney(dv('p-recruit')));
      base.plan.yearsToTop = sum.yearsToTop != null ? sum.yearsToTop : undefined;
      base.effectiveDate = base.plan.effectiveDate;
    } else if (st.mode === 'range') {
      var rBasis = v('c-basis'), rPeriod = v('c-period'), rHours = Lib.parseNumber(dv('c-hours'));
      var rToAnn = function (x) { return toAnnual(x, rPeriod, hoursForMath('c-hours', 'c-sched')); };
      var entryAmt = rToAnn(Lib.parseMoney(dv('c-entry')));
      var midAmt = rToAnn(Lib.parseMoney(dv('c-midpoint')));
      var topAmt = rToAnn(Lib.parseMoney(dv('c-top')));
      Object.assign(pv, {
        payPeriod: rPeriod || undefined,
        basis: rBasis || undefined, effectiveDate: v('c-eff') || undefined,
        schedule: schedVal('c-sched') || undefined, hoursAnnual: rHours || undefined
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
      // Recruit/academy pay — a bonus field alongside the Firefighter scale
      // above, not an alternative to it, so both can publish in one submission.
      // Always a flat base figure, independent of the basis dropdown above.
      var rRecruitPub = rToAnn(Lib.parseMoney(dv('c-recruit')));
      if (rRecruitPub != null) pv.recruit = rRecruitPub;
      base.effectiveDate = pv.effectiveDate;
    } else {
      // Single flat rate — one number, no raise by tenure. Sets BOTH entry and top
      // to the same figure (this is a distinct claim from "I only know entry of a
      // graduated scale", which is what the range tab is for).
      var fBasis = v('c-flat-basis'), fPeriod = v('c-flat-period'), fHours = Lib.parseNumber(dv('c-flat-hours'));
      var fMathHours = hoursForMath('c-flat-hours', 'c-flat-sched');
      var flatAmt = toAnnual(Lib.parseMoney(dv('c-flat-amount')), fPeriod, fMathHours);
      Object.assign(pv, {
        payPeriod: fPeriod || undefined,
        basis: fBasis || undefined, effectiveDate: v('c-flat-eff') || undefined,
        schedule: schedVal('c-flat-sched') || undefined, hoursAnnual: fHours || undefined,
        flatRate: true
      });
      if (flatAmt != null) {
        if (fBasis === 'total') { pv.reportedEntry = flatAmt; pv.reportedTop = flatAmt; }
        else { pv.entry = flatAmt; pv.top = flatAmt; }
      }
      // Recruit/academy pay — a bonus field alongside the flat rate above, not
      // an alternative to it, so both can publish in one submission. Always a
      // flat base figure, independent of the basis dropdown above.
      var fRecruitPub = toAnnual(Lib.parseMoney(dv('c-flat-recruit')), fPeriod, fMathHours);
      if (fRecruitPub != null) pv.recruit = fRecruitPub;
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
  // Automated moderation: a submitted figure gets checked against the
  // department's CURRENT displayed value for that same field (never against
  // another figure in the same submission) — out-of-range or a large jump each
  // add a human-readable reason. Any flags mean the submission publishes as
  // 'flagged' instead of 'published' (js/admin.js's "Flagged submissions" queue
  // reads exactly that status) rather than being blocked outright — an admin
  // reviews and approves it from there.
  function computeAutomatedFlags(pv) {
    var dept = st.dept ? D.get(st.dept) : null;
    var cur = (dept && dept.summary) || {};
    var pairs = [
      ['Entry pay', 'entry', 'entry'], ['Midpoint pay', 'midpoint', 'midpoint'], ['Top pay', 'top', 'topBase'],
      ['Recruit / academy pay', 'recruit', 'recruit'],
      ['Reported entry', 'reportedEntry', 'reportedEntry'], ['Reported midpoint', 'reportedMidpoint', 'reportedMidpoint'], ['Reported top', 'reportedTop', 'reportedTop']
    ];
    var flags = [];
    pairs.forEach(function (p) {
      if (pv[p[1]] == null) return;
      flags = flags.concat(Lib.flagFigure(p[0], pv[p[1]], cur[p[2]]));
    });
    return flags;
  }

  // Guards against a second write while the first is still in flight. save() is
  // async (file upload, then addDoc), so an impatient double-click otherwise
  // creates two documents: consensus dedupes by contributor so the vote isn't
  // double-counted, but the revision history and analytics both show it twice.
  var _saving = false;

  function onSubmit() {
    var status = document.getElementById('form-status');
    if (_saving) return;
    if (!document.getElementById('att-main') || !document.getElementById('att-main').checked) { status.innerHTML = notice('warn', 'Please confirm the accuracy statement.'); return; }
    var fileC = document.getElementById('att-file');
    if (fileC && !fileC.checked) { status.innerHTML = notice('warn', 'Please confirm you can share the attached file.'); return; }
    var payload = gather();
    var pv = payload.proposedValues || {};
    var hasAmount = pv.entry != null || pv.midpoint != null || pv.top != null || pv.recruit != null || pv.reportedEntry != null || pv.reportedMidpoint != null || pv.reportedTop != null;
    // Scheduled annual hours count as a change in their own right — they are the
    // denominator of every effective-hourly figure on the site, and a contributor
    // correcting only the hours was told "nothing changed yet" and turned away.
    var hasChange = hasAmount || (pv.steps && pv.steps.length) || (pv.supplemental && pv.supplemental.length) || pv.schedule || pv.hoursAnnual || pv.effectiveDate || payload.civilService != null || base_effective(payload) || st.type === 'add';
    if (!hasChange) { status.innerHTML = notice('warn', 'No changes to submit — go back and add at least one figure.'); return; }
    payload.automatedFlags = computeAutomatedFlags(pv);
    if (!(A && A.canContribute())) {
      if (!window.FireDB || !window.FireDB.configured) {
        status.innerHTML = notice('info', '<strong>Preview mode — validated, not saved.</strong> This would publish as a preserved revision. Payload:<pre class="mono" style="white-space:pre-wrap;font-size:.72rem;margin:.5rem 0 0">' + UI.esc(JSON.stringify(payload, null, 2)) + '</pre>');
        return;
      }
      // Opens in a new tab deliberately: navigating away here would discard all
      // four steps of typed work, and there is no draft to come back to.
      status.innerHTML = notice('warn', 'Please sign in with a verified email to publish — your entries stay here. <a href="/sign-in.html" target="_blank" rel="noopener">Sign in in a new tab →</a>');
      return;
    }
    setSaving(true);
    if (hasFile()) status.innerHTML = notice('info', 'Uploading source file and publishing…');
    save(payload).then(function (fileUploadFailed) {
      var host = document.getElementById('submit-body');
      var flagged = payload.automatedFlags && payload.automatedFlags.length;
      // Two things this has to get right, both learned the hard way.
      //
      // "Published" describes the RECORD, not the page: the site is static and
      // rebuilds on a schedule, so the figure shows up later. Saying only
      // "published" reads as "it's live now" -- the contributor opens the
      // department page, sees the old number, assumes it failed, and sends it
      // again. So the delay has to be stated.
      //
      // But it must NOT name a number. A promise of "about 5 minutes" is a
      // promise the page cannot keep: the refresh depends on CI, and a CI
      // outage turns a reassuring message into a visibly broken one at exactly
      // the moment trust matters most. What is always true is that the
      // submission is stored safely and will appear at the next refresh --
      // that reassures without asserting a deadline nothing here controls.
      // A held submission must NOT be told it will appear at the next refresh:
      // it will not appear at all until an admin acts on it, and a contributor
      // who believes otherwise just resubmits.
      var held = payload.status === 'location_review' || payload.status === 'possible_duplicate';
      var msg = held
        ? '<strong>Thank you — your submission was received and saved.</strong> ' +
          (payload.status === 'location_review'
            ? 'We could not confirm this department’s location from its ZIP code, so an admin will place it on the map before it appears.'
            : 'It looks similar to a department already listed, so an admin will check it before it appears.') +
          ' Nothing further is needed from you.'
        : flagged
        ? '<strong>Thank you — your submission was received</strong> and is preserved as a revision, but one or more figures look unusual (' + UI.esc(payload.automatedFlags.join('; ')) + '), so it needs a quick admin review before it appears on the site.'
        : '<strong>Thank you — your submission is saved.</strong> It is stored safely and preserved as a revision, and will appear on the department page the next time the site refreshes its community data — usually within a few minutes. There’s no need to send it again if you don’t see it straight away.';
      if (fileUploadFailed) msg += ' <strong>Note:</strong> the attached file could not be uploaded, so it was saved without it — you can add the file later with a follow-up submission.';
      if (window.FireAnalytics) window.FireAnalytics.trackSubmitComplete(st.dept, st.type);
      host.innerHTML = '<div class="notice info" style="font-size:1rem"><span class="notice-icon">✓</span><div>' + msg + '<div style="margin-top:.75rem">' +
        (st.dept ? '<a class="btn btn-outline btn-sm" href="/departments/' + UI.esc(st.dept) + '/">View department</a> ' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="location.reload()">Submit another</button></div></div></div>';
    }).catch(function (err) {
      // Re-enable on failure so a transient error (offline, rules hiccup) can
      // be retried without reloading and re-typing everything.
      setSaving(false);
      status.innerHTML = notice('warn', 'Could not save: ' + UI.esc(err.message) + ' — your entries are still here, try again.');
    });
  }

  function setSaving(on) {
    _saving = on;
    var b = document.getElementById('wiz-submit');
    if (!b) return;
    b.disabled = on;
    b.setAttribute('aria-busy', on ? 'true' : 'false');
    b.textContent = on ? 'Submitting…' : 'Submit for the community';
  }

  function base_effective(p) { return !!(p.plan && p.plan.effectiveDate); }

  function pruneUndefined(o) {
    if (Array.isArray(o)) { o.forEach(pruneUndefined); return o; }
    if (o && typeof o === 'object' && o.constructor === Object) { Object.keys(o).forEach(function (k) { if (o[k] === undefined) delete o[k]; else pruneUndefined(o[k]); }); }
    return o;
  }
  // storage.rules only cares that the path starts with sources/{anything}/{anything} —
  // this doesn't need to be a real department slug, just filesystem-safe.
  function safePathSegment(s) { return String(s || 'unspecified').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unspecified'; }

  // Mirrors scripts/export-overlay.js's normName/isDuplicate exactly (keep the two
  // in sync if either changes) — but runs at CREATE time here, client-side against
  // D.all(), instead of trying to flag an existing department_request after the
  // fact. That earlier approach was blocked: department_requests only allows
  // isAdmin() to update a doc's status, and the export script deliberately runs
  // with zero credentials. A brand-new request can set its OWN initial status
  // freely, so the check belongs here, not there.
  // ── Where is this department, really? ──────────────────────────────────────
  // The Texas ZIP centroid table (window.TexasZipCentroids, loaded by
  // submit.html) is the only thing tying a new department to Texas:
  // scripts/export-overlay.js refuses to place one whose ZIP it cannot resolve,
  // and cross-checks nothing else. That left two failures. A real Texas
  // department with an unrecognized ZIP was dropped in silence, after being
  // told its submission was saved. And a department that is not in Texas at all
  // published happily as long as some Texas ZIP was typed in the box — name,
  // city and county are free text nothing compares against anything.
  //
  // Both are settled here, at CREATE time, because the export runs with zero
  // credentials and cannot re-status a document — the same constraint that put
  // isDuplicateDept() on this side of the wire.
  function zipInfo(zip) {
    var table = window.TexasZipCentroids;
    if (!table || !/^\d{5}$/.test(String(zip || ''))) return null;
    var row = table[zip];
    return row ? { lat: row[0], lng: row[1], city: row[2] || '' } : null;
  }
  function normCity(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  // Returns null when the location looks consistent, otherwise what is off.
  // A city mismatch is NOT proof of anything: Texas departments routinely sit
  // in unincorporated areas, ESDs and districts whose post-office city is a
  // neighbouring town, so this can never block a submission — it routes it to
  // an admin who can confirm the pin before it reaches the map.
  function locationProblem() {
    // No table (blocked, still loading, file renamed) — never guess.
    if (!window.TexasZipCentroids) return null;
    var zip = v('f-zip'), city = v('f-city');
    var info = zipInfo(zip);
    if (!info) return { kind: 'unknown-zip', zip: zip };
    if (!city || !info.city) return null;
    var a = normCity(city), b = normCity(info.city);
    if (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return null;
    return { kind: 'city-mismatch', zip: zip, zipCity: info.city, city: city };
  }
  function locationWarning(loc) {
    if (!loc) return [];
    if (loc.kind === 'unknown-zip') {
      return ['ZIP ' + loc.zip + ' isn\u2019t in our Texas ZIP list, so this department can\u2019t be placed on the map automatically. You can still submit it \u2014 an admin will position it by hand \u2014 but it is worth double-checking the ZIP first.'];
    }
    return ['ZIP ' + loc.zip + ' is ' + loc.zipCity + ', not ' + loc.city + '. If that\u2019s right (a district or unincorporated area often shares a neighbouring town\u2019s post-office city) go ahead \u2014 an admin will confirm the location before it appears on the map.'];
  }
  // Echoes the ZIP back as the contributor types it. Catching a typo here, while
  // they can still see what they meant, beats every downstream remedy.
  function renderZipResolved() {
    var host = document.getElementById('f-zip-resolved');
    if (!host) return;
    var zip = v('f-zip');
    if (!/^\d{5}$/.test(zip)) { host.textContent = ''; return; }
    if (!window.TexasZipCentroids) { host.textContent = ''; return; }
    var info = zipInfo(zip);
    if (!info) { host.innerHTML = '<span class="field-error">Not a Texas ZIP we recognize \u2014 check it, or submit and an admin will place it.</span>'; return; }
    host.textContent = '\u2713 ' + info.city + ', TX';
  }

  function normDeptName(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(fire department|fire rescue|department|dept|fd|esd|no|number)\b/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function isDuplicateDept(name, city) {
    var n = normDeptName(name), c = String(city || '').toLowerCase().trim();
    if (!n || !c) return false;
    return D.all().some(function (d) {
      if (String(d.city || '').toLowerCase().trim() !== c) return false;
      var dn = normDeptName(d.name);
      return dn === n || dn.indexOf(n) !== -1 || n.indexOf(dn) !== -1;
    });
  }

  // Uploads the attached file (if any) to Storage BEFORE writing the Firestore
  // doc, and sets sourceFile to its public download URL — storage.rules already
  // allows public read on sources/**, verified-write with a 10MB/image-or-PDF
  // limit (matching the client-side check in wireStep()'s file-select handler).
  // Backfills sourceUrl too when no separate public link was given, so every
  // existing "View pay plan ↗" link just works with no further changes.
  async function uploadSourceFile(db, payload) {
    var input = document.getElementById('src-file');
    var file = input && input.files && input.files[0];
    if (!file) return;
    var St = db.sdk.storage;
    var folder = safePathSegment(payload.departmentSlug || payload.name);
    var path = 'sources/' + folder + '/' + Date.now() + '-' + safePathSegment(file.name.replace(/\.[^.]+$/, '')) + (file.name.match(/\.[^.]+$/) || [''])[0];
    var fileRef = St.ref(db.storage, path);
    await St.uploadBytes(fileRef, file);
    var url = await St.getDownloadURL(fileRef);
    payload.sourceFile = url;
    if (!payload.sourceUrl) payload.sourceUrl = url;
  }

  async function save(payload) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    // The attached file is supplementary evidence, not the submission itself —
    // if the upload fails (e.g. Storage isn't enabled on the project yet), the
    // salary data the contributor typed should still save rather than the whole
    // submission being lost.
    var fileUploadFailed = false;
    try {
      await uploadSourceFile(db, payload);
    } catch (e) {
      console.warn('[submit] source file upload failed; publishing without the attachment', e);
      fileUploadFailed = true;
    }
    pruneUndefined(payload);
    payload.contributorId = A.user.uid; payload.submittedAt = F.serverTimestamp();
    // computeAutomatedFlags() (called from onSubmit(), before save()) already set
    // payload.automatedFlags — status follows from whether it found anything.
    // A likely-duplicate new department takes priority over that: it publishes
    // as 'possible_duplicate' regardless (admin.js's q-dupes queue reads exactly
    // that status), since flagging a duplicate is more specific/actionable than
    // a generic "review this" — submissions never sets this status; only
    // department_requests (submissionType 'add') can be a duplicate at all.
    payload.automatedFlags = payload.automatedFlags || [];
    if (payload.submissionType === 'add' && payload.possibleDuplicate) {
      payload.status = 'possible_duplicate';
    } else if (payload.submissionType === 'add' && payload.locationReview) {
      // Held for admin placement instead of published. An unresolvable ZIP
      // could never have been promoted anyway (it would just have vanished);
      // a ZIP that disagrees with the city is how a department outside Texas
      // would otherwise land on the map at a real Texas department's
      // coordinates. firestore.rules keeps a non-published request readable
      // only by an admin, so it waits in the queue rather than going live.
      payload.status = 'location_review';
    } else {
      payload.status = payload.automatedFlags.length ? 'flagged' : 'published';
    }
    var col = payload.submissionType === 'add' ? 'department_requests' : 'submissions';
    await F.addDoc(F.collection(db.db, col), payload);
    return fileUploadFailed;
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
