/*
 * submit.js — Community submission wizard (submit.html). Mobile-first, several
 * paths: Quick update · Complete pay plan · Add a department. Duplicate search
 * before adding, optional source with a sensitive-document warning, and required
 * contributor attestations. Writes preserved revision docs to Firestore when
 * connected; otherwise runs in a clearly-labeled preview mode.
 */
(function () {
  'use strict';
  var UI = window.FireUI, Lib = window.FireSalaryLib, D = window.FireData, A = window.FireAuth;
  var tab = 'update';

  var SALARY_TYPES = [
    ['recruit', 'Recruit salary'], ['ff-emt-entry', 'Firefighter/EMT entry salary'],
    ['ff-medic-entry', 'Firefighter/paramedic entry salary'], ['top-ff', 'Top firefighter salary'],
    ['top-ff-medic', 'Top firefighter/paramedic salary'], ['hourly-base', 'Hourly base rate'],
    ['annual-base', 'Annual base salary'], ['annual-total', 'Annual compensation incl. scheduled overtime']
  ];

  document.addEventListener('DOMContentLoaded', function () {
    D.load().then(function () {
      var p = new URLSearchParams(location.search);
      var mode = p.get('mode');
      if (mode === 'add') tab = 'add'; else if (mode === 'step') tab = 'plan'; else tab = 'update';
      wireTabs();
      renderGate();
      renderTab(p.get('dept') || '');
    });
    if (A) A.onChange(renderGate);
  });

  function renderGate() {
    var g = document.getElementById('submit-gate');
    if (!g) return;
    if (A && A.canContribute()) { g.classList.remove('show'); return; }
    g.classList.add('show');
    if (!window.FireDB || !window.FireDB.configured) {
      g.innerHTML = '<span aria-hidden="true">🔎</span><div><strong>Preview mode.</strong> Firebase isn\'t connected in this build, so submissions are validated and summarized but not saved. Connect Firebase to publish. You can still walk through every form.</div>';
    } else if (A && A.isSignedIn() && !A.isVerified()) {
      g.innerHTML = '<span aria-hidden="true">📧</span><div>Please verify your email before publishing. <button class="btn btn-outline btn-sm" id="resend">Resend verification</button></div>';
      var r = document.getElementById('resend'); if (r) r.onclick = function () { A.sendVerification().then(function () { r.textContent = 'Sent'; }); };
    } else {
      g.innerHTML = '<span aria-hidden="true">🔒</span><div>Sign in with a verified email to publish. <a href="/sign-in.html">Sign in →</a></div>';
    }
  }

  function wireTabs() {
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        document.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderTab('');
      });
    });
  }

  function deptSelect(id, selected) {
    var opts = '<option value="">— Select a department —</option>' + D.all().map(function (d) {
      return '<option value="' + UI.esc(d.slug) + '"' + (d.slug === selected ? ' selected' : '') + '>' + UI.esc(d.name) + ' (' + UI.esc(d.city) + ')</option>';
    }).join('');
    return '<div class="field"><label for="' + id + '">Department</label><select id="' + id + '" required>' + opts + '</select></div>';
  }

  function sourceBlock() {
    return '<div class="divider-label">Optional source</div>' +
      '<div class="notice warn" style="margin-bottom:1rem"><span class="notice-icon">⚠</span><div><strong>Do not upload sensitive material.</strong> No personal pay stubs, employee numbers, SSNs, medical info, disciplinary records, or confidential personnel documents. Only share public pay plans, flyers, or documents you are authorized to share. Image metadata is stripped when practical.</div></div>' +
      '<div class="field"><label for="src-url">Public source URL (pay plan, careers page, CBA)</label><input id="src-url" type="url" placeholder="https://"></div>' +
      '<div class="field"><label for="src-file">Upload a pay plan / flyer (optional)</label><input id="src-file" type="file" accept="image/*,application/pdf"></div>';
  }

  function attestBlock() {
    return '<div class="divider-label">Confirm</div>' +
      '<div class="stack">' +
      check('att1', 'I believe this information is accurate.') +
      check('att2', 'I am not uploading personal pay stubs or other sensitive personal information.') +
      check('att3', 'I have the right to share any material I upload.') +
      check('att4', 'I understand my submission may be edited, compared, and displayed publicly.') +
      '</div>';
  }
  function check(id, label) { return '<div class="checkline"><input type="checkbox" id="' + id + '" required><label for="' + id + '">' + label + '</label></div>'; }
  function numField(id, label, hint) { return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="number" inputmode="decimal" placeholder="' + (hint || '') + '"></div>'; }

  function renderTab(prefillDept) {
    var host = document.getElementById('submit-body');
    if (!host) return;
    if (tab === 'update') host.innerHTML = quickUpdateForm(prefillDept);
    else if (tab === 'plan') host.innerHTML = payPlanForm(prefillDept);
    else host.innerHTML = addDeptForm();
    wireForm();
  }

  function quickUpdateForm(prefill) {
    return '<form id="the-form" novalidate><h2>Quick update</h2>' +
      '<p class="muted">Update one or more fields for an existing department. Every submission is preserved as a revision.</p>' +
      deptSelect('f-dept', prefill) +
      '<div class="field"><label for="f-class">Position / classification</label><input id="f-class" placeholder="e.g. Firefighter, FF-Paramedic, Driver-Engineer"></div>' +
      '<div class="grid cols-2">' +
        numField('f-amount', 'Salary amount', '$') +
        '<div class="field"><label for="f-type">Salary type</label><select id="f-type">' + SALARY_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === 'ff-emt-entry' ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="f-eff">Effective date (or year)</label><input id="f-eff" type="text" inputmode="numeric" placeholder="2026-01-01 or 2026"></div>' +
        '<div class="field"><label for="f-basis">This amount is…</label><select id="f-basis"><option value="base">Base salary only</option><option value="total">Total reported comp (incl. scheduled OT)</option></select></div>' +
      '</div>' +
      '<div class="checkline"><input type="checkbox" id="f-ot"><label for="f-ot">This amount includes scheduled overtime</label></div>' +
      '<details class="filter-group" style="margin-top:1rem"><summary>Optional details</summary><div class="stack" style="margin-top:.6rem">' +
        '<div class="grid cols-2">' +
          '<div class="field"><label for="f-sched">Shift schedule</label><input id="f-sched" placeholder="24/48"></div>' +
          numField('f-ytt', 'Years to top', 'yrs') +
        '</div>' +
        '<div class="grid cols-2">' + numField('f-medic', 'Paramedic incentive', '$/yr') + numField('f-hours', 'Annual scheduled hours', '2912') + '</div>' +
        '<div class="field"><label for="f-hiring">Hiring status</label><select id="f-hiring"><option value="">No change</option><option value="hiring">Currently hiring</option><option value="not-hiring">Not hiring</option></select></div>' +
      '</div></details>' +
      '<div class="field" style="margin-top:1rem"><label for="f-notes">Notes (context only, not the main data)</label><textarea id="f-notes" placeholder="e.g. amount reflects the 2026 approved pay scale, step 1."></textarea></div>' +
      sourceBlock() + attestBlock() +
      submitButtons() + '</form>';
  }

  function payPlanForm(prefill) {
    return '<form id="the-form" novalidate><h2>Complete pay plan</h2>' +
      '<p class="muted">Enter each step. Only fill the columns you have — blank cells are fine.</p>' +
      deptSelect('f-dept', prefill) +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="f-eff">Effective date</label><input id="f-eff" type="text" inputmode="numeric" placeholder="2026-01-01"></div>' +
        '<div class="field"><label for="f-class">Classification</label><input id="f-class" placeholder="Firefighter"></div>' +
      '</div>' +
      '<div class="checkline"><input type="checkbox" id="f-ot"><label for="f-ot">Reported compensation includes scheduled overtime</label></div>' +
      '<div class="table-scroll" style="margin:1rem 0"><table class="data" id="step-table" style="min-width:640px"><thead><tr>' +
        '<th>Step</th><th class="num">Min months</th><th class="num">Base annual</th><th class="num">Sched. OT</th><th class="num">Paramedic</th><th class="num">Reported total</th><th></th>' +
      '</tr></thead><tbody></tbody></table></div>' +
      '<button type="button" class="btn btn-outline btn-sm" id="add-step">＋ Add step</button>' +
      sourceBlock() + attestBlock() + submitButtons() + '</form>';
  }

  function addDeptForm() {
    return '<form id="the-form" novalidate><h2>Add a department</h2>' +
      '<p class="muted">First, let\'s make sure it isn\'t already listed.</p>' +
      '<div class="field"><label for="f-search">Search existing departments</label><input id="f-search" placeholder="Name, city, or ZIP"><div id="dup-results" class="stack" style="margin-top:.5rem"></div></div>' +
      '<div class="divider-label">New department details</div>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="f-name">Department name</label><input id="f-name" required></div>' +
        '<div class="field"><label for="f-city">City</label><input id="f-city" required></div>' +
      '</div>' +
      '<div class="grid cols-3">' +
        '<div class="field"><label for="f-county">County</label><input id="f-county"></div>' +
        '<div class="field"><label for="f-zip">ZIP</label><input id="f-zip" inputmode="numeric"></div>' +
        '<div class="field"><label for="f-type">Type</label><select id="f-type"><option value="municipal">Municipal</option><option value="esd">Emergency services district</option><option value="county">County</option><option value="university">University</option><option value="airport">Airport</option><option value="fire-rescue-district">Fire-rescue district</option><option value="combination">Combination</option><option value="other">Other</option></select></div>' +
      '</div>' +
      '<div class="field"><label for="f-web">Website or careers URL (helps us avoid duplicates)</label><input id="f-web" type="url" placeholder="https://"></div>' +
      attestBlock() + submitButtons('Add department') + '</form>';
  }

  function submitButtons(label) {
    return '<div style="display:flex;gap:.75rem;margin-top:1.5rem;flex-wrap:wrap">' +
      '<button type="submit" class="btn btn-primary btn-lg">' + (label || 'Submit for the community') + '</button>' +
      '<a class="btn btn-ghost" href="/how-it-works.html">How submissions work</a></div>' +
      '<div id="form-status" style="margin-top:1rem"></div>';
  }

  function wireForm() {
    // pay-plan step rows
    var addStep = document.getElementById('add-step');
    if (addStep) {
      var tbody = document.querySelector('#step-table tbody');
      function addRow() {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td><input placeholder="Firefighter"></td>' +
          ['months', 'base', 'ot', 'medic', 'reported'].map(function () { return '<td><input type="number" inputmode="decimal" style="min-width:90px"></td>'; }).join('') +
          '<td><button type="button" class="btn btn-ghost btn-sm rm">✕</button></td>';
        tr.querySelector('.rm').onclick = function () { tr.remove(); };
        tbody.appendChild(tr);
      }
      addStep.onclick = addRow; addRow(); addRow();
    }
    // duplicate search
    var search = document.getElementById('f-search');
    if (search) {
      var res = document.getElementById('dup-results');
      search.addEventListener('input', function () {
        var list = search.value.trim() ? D.search(search.value.trim()) : [];
        res.innerHTML = list.length
          ? '<div class="notice info"><span class="notice-icon">ℹ</span><div>Possible matches — is it one of these?<ul style="margin:.3rem 0 0;padding-left:1.1rem">' + list.map(function (d) { return '<li><a href="/departments/' + UI.esc(d.slug) + '/">' + UI.esc(d.name) + '</a> — ' + UI.esc(d.city) + '</li>'; }).join('') + '</ul></div></div>'
          : '';
      });
    }
    var form = document.getElementById('the-form');
    if (form) form.addEventListener('submit', onSubmit);
  }

  function onSubmit(e) {
    e.preventDefault();
    var status = document.getElementById('form-status');
    // attestations
    var missing = ['att1', 'att2', 'att3', 'att4'].filter(function (id) { var el = document.getElementById(id); return el && !el.checked; });
    if (missing.length) { status.innerHTML = notice('warn', 'Please confirm all four statements before submitting.'); return; }

    var payload = gather();
    if (tab !== 'add' && !payload.departmentSlug) { status.innerHTML = notice('warn', 'Please choose a department.'); return; }
    if (tab === 'add' && !payload.name) { status.innerHTML = notice('warn', 'Please enter a department name.'); return; }

    if (!(A && A.canContribute())) {
      if (!window.FireDB || !window.FireDB.configured) {
        status.innerHTML = notice('info', '<strong>Preview mode — validated, not saved.</strong> This submission would be published without owner approval and preserved as a revision. Payload:<pre class="mono" style="white-space:pre-wrap;font-size:.75rem;margin:.5rem 0 0">' + UI.esc(JSON.stringify(payload, null, 2)) + '</pre>');
        return;
      }
      status.innerHTML = notice('warn', 'Please sign in with a verified email to publish. <a href="/sign-in.html">Sign in →</a>');
      return;
    }
    save(payload).then(function () {
      status.innerHTML = notice('info', 'Thank you — your submission is published and preserved as a revision. The community consensus will update automatically.');
      document.getElementById('the-form').reset();
    }).catch(function (err) { status.innerHTML = notice('warn', 'Could not save: ' + UI.esc(err.message)); });
  }

  function gather() {
    function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    function b(id) { var el = document.getElementById(id); return !!(el && el.checked); }
    var base = { submissionType: tab, contributorType: (A && A.profile && A.profile.role === 'department') ? 'department' : 'community', sourceUrl: v('src-url') || null };
    if (tab === 'add') {
      return Object.assign(base, { name: v('f-name'), city: v('f-city'), county: v('f-county'), zip: v('f-zip'), departmentType: v('f-type'), website: v('f-web') });
    }
    base.departmentSlug = v('f-dept');
    if (tab === 'plan') {
      var steps = [];
      document.querySelectorAll('#step-table tbody tr').forEach(function (tr) {
        var i = tr.querySelectorAll('input');
        var name = i[0].value.trim();
        if (!name && !i[2].value) return;
        steps.push({ stepName: name, minimumMonths: Lib.parseNumber(i[1].value), baseAnnualSalary: Lib.parseMoney(i[2].value), scheduledOvertime: Lib.parseMoney(i[3].value), paramedicPay: Lib.parseMoney(i[4].value), reportedAnnualCompensation: Lib.parseMoney(i[5].value) });
      });
      return Object.assign(base, { effectiveDate: v('f-eff'), classification: v('f-class'), includesScheduledOvertime: b('f-ot'), proposedValues: { steps: steps } });
    }
    // quick update — map the amount to the entry or top figure by salary type.
    var amount = Lib.parseMoney(v('f-amount'));
    var stype = v('f-type');
    var metric = (stype === 'top-ff' || stype === 'top-ff-medic') ? 'top' : (stype === 'hourly-base' ? 'skip' : 'entry');
    return Object.assign(base, {
      classification: v('f-class'), effectiveDate: v('f-eff'), includesScheduledOvertime: b('f-ot'),
      proposedValues: {
        amount: amount, salaryType: stype, basis: v('f-basis'),
        entry: metric === 'entry' ? amount : undefined,
        top: metric === 'top' ? amount : undefined,
        schedule: v('f-sched') || undefined, yearsToTop: Lib.parseNumber(v('f-ytt')) || undefined,
        paramedicPay: Lib.parseMoney(v('f-medic')) || undefined, annualScheduledHours: Lib.parseNumber(v('f-hours')) || undefined,
        hiringStatus: v('f-hiring') || undefined
      },
      notes: v('f-notes').slice(0, 800)
    });
  }

  // Recursively drop undefined keys (blank optional fields) so the stored doc is
  // clean; also belt-and-suspenders with firebase-init's ignoreUndefinedProperties.
  function pruneUndefined(o) {
    if (o && typeof o === 'object' && o.constructor === Object) {
      Object.keys(o).forEach(function (k) {
        if (o[k] === undefined) delete o[k];
        else pruneUndefined(o[k]);
      });
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
    payload.status = 'published';          // no owner approval for routine submissions
    payload.automatedFlags = [];
    var col = payload.submissionType === 'add' ? 'department_requests' : 'submissions';
    await F.addDoc(F.collection(db.db, col), payload);
  }

  function notice(kind, html) { return '<div class="notice ' + kind + '"><span class="notice-icon">' + (kind === 'warn' ? '⚠' : 'ℹ') + '</span><div>' + html + '</div></div>'; }
})();
