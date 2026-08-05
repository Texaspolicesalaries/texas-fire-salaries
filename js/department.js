/*
 * department.js — Progressive enhancement for a generated department page.
 *
 * The static page (built by scripts/build-site.js) carries the crawlable baseline
 * (summary cards, pay-step table, key facts) plus an embedded JSON blob. This
 * script overlays live community reports from Firestore, then renders the
 * interactive sections: career earnings, salary-history chart, the community-
 * confidence panel with confirm/dispute actions, and the public revision history.
 */
(function () {
  'use strict';
  var UI = window.FireUI, Lib = window.FireSalaryLib, D = window.FireData, A = window.FireAuth;

  var dept, summary;

  // ── Read-cost control ──────────────────────────────────────────────────────
  // By default a department page renders ENTIRELY from the static baseline that
  // `npm run build` baked in — that is ZERO Firestore reads per visitor, no
  // matter how large the department list or how much traffic the page gets.
  // Set this to true only if you want every page view to also pull live
  // submissions from Firestore (~1 query per view — reads then scale with
  // traffic). The recommended low-cost path is to leave it false and refresh
  // the static baseline with a periodic rebuild (the aggregate-on-write loop).
  var LIVE_OVERLAY = false;

  // Link to the department's pay-plan source when we have a real URL, else plain text.
  function payPlanLink(linkLabel, fallbackLabel) {
    return (summary && summary.sourceUrl)
      ? '<a href="' + UI.esc(summary.sourceUrl) + '" target="_blank" rel="nofollow noopener">' + linkLabel + '</a>'
      : (fallbackLabel || '');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var node = document.getElementById('dept-data');
    if (!node) return;
    try { dept = JSON.parse(node.textContent); } catch (e) { console.error('bad dept-data', e); return; }
    summary = D.deriveSummary(dept);
    renderAll();
    // Optional live overlay — off by default to keep visitor reads at zero.
    if (LIVE_OVERLAY) {
      D.fetchDepartmentReports(dept.slug).then(function (extra) {
        if (extra && extra.length) { summary = D.deriveSummary(dept, extra); renderAll(); }
      });
    }
    // Only signed-in users trigger these reads — anonymous visitors still cost 0.
    if (A) A.onChange(function (user) {
      if (!user) return;
      checkClaimNotifications();
      if (summary.departmentMaintained) renderClaimedByMe();
    });
  });

  function renderAll() {
    renderCareer();
    renderHistory();
    renderConfidence();
    renderRevisions();
    renderClaim();
    wireActions();
    wireStepPlanFlag();
  }

  // ---- Claim this department ----
  // A signed-in, verified user can request "Department maintained" status.
  // Their own account's email domain is used automatically (an official rep
  // signs in with their own work email) rather than asking them to type it.
  // Nothing here sets departmentMaintained directly — that's a deliberate
  // review step: writes a pending department_claims doc; js/admin.js's
  // q-claims queue approves/rejects it, and an approval only takes effect on
  // the department page once scripts/export-overlay.js's next scheduled run
  // picks it up (js/aggregate.js's applyClaim).
  function renderClaim() {
    var host = document.getElementById('claim-panel');
    if (!host) return;
    // Already claimed: the public "◆ Department maintained" badge in the
    // header covers every visitor, but the claimant themselves gets nothing
    // to distinguish "this is generically maintained" from "this is MY dept"
    // — a one-time toast is easy to miss, so renderClaimedByMe() (wired
    // through auth below, once signed-in state is known) fills this panel
    // with a standing reminder every time they're on their own department's
    // page, instead of just leaving it blank.
    if (summary.departmentMaintained) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="card card-tight">' +
      '<h3 style="margin-bottom:.4rem">Represent this department?</h3>' +
      '<p class="muted" style="margin-bottom:.6rem">If you manage this page officially, request "Department maintained" status. An admin reviews every request.</p>' +
      '<button class="btn btn-outline btn-sm" id="act-claim">Claim this department</button>' +
      '<div id="claim-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>';
    var btn = document.getElementById('act-claim');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var claimStatus = document.getElementById('claim-status');
      if (!(A && A.canContribute())) {
        claimStatus.innerHTML = 'Sign in with a verified email to submit a claim. <a href="/sign-in.html">Sign in →</a>';
        return;
      }
      var oldLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Submitting…';
      writeClaim().then(function () {
        claimStatus.textContent = 'Thanks — your claim was submitted and is pending admin review.';
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = oldLabel;
        claimStatus.innerHTML = '<span class="field-error">Could not submit: ' + UI.esc(e.message) + '</span>';
      });
    });
  }

  // Approved claims are public-read per firestore.rules (status=='approved'),
  // so this can check "is the signed-in visitor the one who claimed THIS
  // department" without ever exposing anyone else's identity — it only
  // renders anything when their own uid matches, and stays blank for every
  // other visitor exactly as before. Runs every page view of a claimed
  // department (not gated by localStorage, unlike the one-time toast) since
  // the whole point is a standing reminder, not a one-off notice.
  async function renderClaimedByMe() {
    var host = document.getElementById('claim-panel');
    if (!host || !A || !A.isSignedIn()) return;
    var db = window.FireDB;
    if (!db || !db.ready) return;
    try {
      var F = db.sdk.firestore;
      var qy = F.query(F.collection(db.db, 'department_claims'),
        F.where('departmentSlug', '==', dept.slug), F.where('status', '==', 'approved'), F.limit(5));
      var snap = await F.getDocs(qy);
      var mine = false;
      snap.forEach(function (doc) { if (doc.data().userId === A.user.uid) mine = true; });
      if (mine) {
        host.innerHTML = '<div class="notice info"><span class="notice-icon" aria-hidden="true">◆</span><div>' +
          '<strong>You are the verified contact for ' + UI.esc(dept.name) + '.</strong> ' +
          'A pay figure you submit becomes the one shown here right away, without waiting to out-vote other community reports.</div></div>';
      }
    } catch (e) { /* nice-to-have only — never block the page over it */ }
  }

  async function writeClaim() {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    var email = (A.user && A.user.email) || '';
    var domain = email.indexOf('@') !== -1 ? email.split('@')[1] : '';
    // The full email is what an admin actually needs to judge a claim (does
    // this look like an official department address, do they recognize the
    // person) — emailDomain alone ("gmail.com") tells them nothing. This is
    // never shown publicly: firestore.rules only lets an admin or the
    // claimant themselves read a pending claim doc.
    await F.addDoc(F.collection(db.db, 'department_claims'), {
      userId: A.user.uid, departmentSlug: dept.slug, departmentName: dept.name, email: email, emailDomain: domain, status: 'pending', createdAt: F.serverTimestamp()
    });
  }

  // ---- "Your claim was approved/rejected" notice ----
  // The claimant gets no email/push when an admin resolves their claim — the
  // only way to find out is to notice the badge appear (or the claim button
  // vanish) on that department's own page. This surfaces it wherever they
  // happen to be signed in, on ANY department page, not just the one they
  // claimed. departmentName is stored on the claim doc itself (not looked up)
  // because this page's embedded dept-data is for whichever department the
  // visitor is CURRENTLY looking at, not necessarily the one that was claimed.
  function claimSeenKey(id) { return 'fireClaimSeen_' + id; }
  async function checkClaimNotifications() {
    var host = document.getElementById('claim-notice');
    if (!host || !A || !A.canContribute()) return;
    var db = window.FireDB;
    if (!db || !db.ready) return;
    try {
      var F = db.sdk.firestore;
      var qy = F.query(F.collection(db.db, 'department_claims'), F.where('userId', '==', A.user.uid), F.limit(20));
      var snap = await F.getDocs(qy);
      var notices = [];
      snap.forEach(function (doc) {
        var c = doc.data();
        if (c.status !== 'approved' && c.status !== 'rejected') return; // nothing to report on a still-pending claim
        var key = claimSeenKey(doc.id);
        var seen = null;
        try { seen = localStorage.getItem(key); } catch (e) {}
        if (seen === c.status) return; // already shown this exact resolution
        try { localStorage.setItem(key, c.status); } catch (e) {}
        var name = UI.esc(c.departmentName || c.departmentSlug || 'that department');
        var link = c.departmentSlug ? ' <a href="/departments/' + UI.esc(c.departmentSlug) + '/">View page →</a>' : '';
        notices.push(c.status === 'approved'
          ? '<div class="notice info" style="margin-bottom:.75rem"><span class="notice-icon" aria-hidden="true">✓</span><div><strong>Your claim for ' + name + ' was approved.</strong> The page now shows "Department maintained."' + link + '</div></div>'
          : '<div class="notice warn" style="margin-bottom:.75rem"><span class="notice-icon" aria-hidden="true">ⓘ</span><div><strong>Your claim for ' + name + ' was not approved.</strong> You can submit a new claim if this was a mistake.</div></div>');
      });
      if (notices.length) host.innerHTML = notices.join('');
    } catch (e) { /* nice-to-have only — never block the page over it */ }
  }

  // ---- Career earnings ----
  function renderCareer() {
    var host = document.getElementById('career-earnings');
    if (!host || !summary.hasSalary || !summary.steps) { if (host) host.innerHTML = ''; return; }
    var baseSteps = Lib.stepsForField(summary.steps, 'baseAnnualSalary');
    var repSteps = Lib.stepsForField(summary.steps, 'reportedAnnualCompensation');
    function cell(steps, y) { var r = Lib.projectEarnings(steps, y); return r.total == null ? '—' : { total: UI.money(r.total), cf: r.assumedCarryForward }; }
    var years = [5, 10, 20];
    var anyCF = years.some(function (y) { return Lib.projectEarnings(baseSteps, y).assumedCarryForward || Lib.projectEarnings(repSteps, y).assumedCarryForward; });
    function rowFor(label, steps) {
      return '<tr><th scope="row">' + label + '</th>' + years.map(function (y) {
        var c = cell(steps, y); var v = (typeof c === 'object') ? c.total : c;
        return '<td class="num">' + v + '</td>';
      }).join('') + '</tr>';
    }
    host.innerHTML =
      '<h2>Career earnings</h2>' +
      '<p class="muted">Cumulative earnings if a firefighter progressed through this reported step plan. <strong>Base salary</strong> and <strong>reported total compensation</strong> are kept separate — do not add them together.</p>' +
      '<div class="table-scroll"><table class="data"><thead><tr><th scope="col">Basis</th><th class="num" scope="col">5 years</th><th class="num" scope="col">10 years</th><th class="num" scope="col">20 years</th></tr></thead><tbody>' +
        rowFor('Base salary', baseSteps) +
        (repSteps.length ? rowFor('Reported total compensation', repSteps) : '') +
      '</tbody></table></div>' +
      '<p class="field-hint" style="margin-top:.5rem">Assumes the step in effect at the start of each service year.' +
        (anyCF ? ' Where the plan\'s final step is bounded, it assumes the final submitted step continues for later years.' : '') +
        ' Excludes raises, promotions, actual overtime worked, and benefits.</p>';
  }

  // ---- Salary history (SVG chart + table) ----
  function renderHistory() {
    var host = document.getElementById('salary-history');
    if (!host) return;
    var reports = ((dept.salary && dept.salary.reports) || []).slice().filter(function (r) { return r.entry != null && r.submittedAt; });
    if (!reports.length) { host.innerHTML = ''; return; }
    reports.sort(function (a, b) { return Date.parse(a.submittedAt) - Date.parse(b.submittedAt); });
    var pts = reports.map(function (r) { return { t: Date.parse(r.submittedAt), entry: r.entry, top: r.top, when: r.submittedAt }; });

    host.innerHTML = '<h2>Salary history</h2>' + (pts.length >= 2 ? chartSVG(pts) : '') + historyTable(reports);
  }

  function chartSVG(pts) {
    var W = 620, H = 220, pad = { l: 56, r: 16, t: 16, b: 28 };
    var xs = pts.map(function (p) { return p.t; });
    var vals = []; pts.forEach(function (p) { vals.push(p.entry); if (p.top != null) vals.push(p.top); });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, vals) * 0.96, maxY = Math.max.apply(null, vals) * 1.04;
    if (minX === maxX) { minX -= 86400000 * 180; maxX += 86400000 * 180; }
    function sx(t) { return pad.l + (t - minX) / (maxX - minX || 1) * (W - pad.l - pad.r); }
    function sy(v) { return H - pad.b - (v - minY) / (maxY - minY || 1) * (H - pad.t - pad.b); }
    function line(key, cls) {
      var have = pts.filter(function (p) { return p[key] != null; });
      if (have.length < 1) return '';
      var d = have.map(function (p, i) { return (i ? 'L' : 'M') + sx(p.t).toFixed(1) + ' ' + sy(p[key]).toFixed(1); }).join(' ');
      var dots = have.map(function (p) { return '<circle class="dot" cx="' + sx(p.t).toFixed(1) + '" cy="' + sy(p[key]).toFixed(1) + '" r="3.5" style="stroke:var(--accent' + (cls === 'top' ? '-2' : '') + ')"/>'; }).join('');
      return '<path class="series ' + cls + '" d="' + d + '"/>' + dots;
    }
    var yTicks = [minY, (minY + maxY) / 2, maxY].map(function (v) {
      return '<text x="' + (pad.l - 8) + '" y="' + (sy(v) + 4) + '" text-anchor="end" font-size="10" fill="var(--text-faint)">' + UI.money(Math.round(v / 1000) * 1000) + '</text>' +
        '<line class="grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/>';
    }).join('');
    return '<div class="chart"><div class="chart-legend" style="margin-bottom:.4rem"><span class="k">Entry FF</span>' + (pts.some(function (p) { return p.top != null; }) ? '<span class="k top">Top FF</span>' : '') + '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Reported entry and top firefighter salary over time">' +
      yTicks + line('entry', 'entry') + line('top', 'top') + '</svg></div>';
  }

  function historyTable(reports) {
    return '<div class="table-scroll" style="margin-top:1rem"><table class="data"><thead><tr>' +
      '<th scope="col">Submitted</th><th class="num" scope="col">Entry FF</th><th class="num" scope="col">Top FF</th><th scope="col">Source</th></tr></thead><tbody>' +
      reports.slice().reverse().map(function (r) {
        return '<tr><td>' + UI.esc(r.submittedAt) + '</td><td class="num">' + UI.money(r.entry) + '</td><td class="num">' + (r.top != null ? UI.money(r.top) : '—') + '</td><td>' + (r.hasSource ? payPlanLink('View pay plan ↗', 'Source on file') : 'Community report') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ---- Community confidence panel + actions ----
  var DISPUTE_FIELDS = [['entry', 'Entry pay'], ['midpoint', 'Midpoint pay'], ['top', 'Top pay']];

  function renderConfidence() {
    var host = document.getElementById('confidence-panel');
    if (!host) return;
    var s = summary;
    var clusters = s.clusters || [];
    var newest = s.newestSubmission ? new Date(s.newestSubmission).toISOString().slice(0, 10) : '—';
    var oldest = s.oldestCurrent ? new Date(s.oldestCurrent).toISOString().slice(0, 10) : '—';
    // A disputed figure stays showing (never silently reverted by a single flag)
    // until enough distinct community members dispute the SAME value — see
    // scripts/export-overlay.js's applyValueDisputes. Below the threshold, it's
    // just called out here so visitors know it's contested.
    var disputed = DISPUTE_FIELDS.filter(function (f) { return (s[f[0] + 'DisputeCount'] || 0) > 0; });
    var disputeNotice = disputed.length
      ? '<div class="notice warn" style="margin-bottom:1rem"><span class="notice-icon" aria-hidden="true">⚠</span><div>' +
        disputed.map(function (f) { return f[1] + ' disputed by ' + s[f[0] + 'DisputeCount'] + ' community member' + (s[f[0] + 'DisputeCount'] === 1 ? '' : 's'); }).join('; ') +
        '. It will revert to the prior value if enough others agree.</div></div>'
      : '';
    host.innerHTML =
      '<h2>Community confidence</h2>' +
      disputeNotice +
      '<div class="tag-row" style="margin-bottom:1rem">' + UI.confidenceChip(s.confidence) + UI.freshnessChip(s.freshness) + (s.departmentMaintained ? UI.deptMaintainedBadge() : '') + '</div>' +
      '<div class="confidence-panel">' +
        '<div class="card card-tight">' +
          stat('Matching submissions', clusters.length ? clusters[0].submissions.length : 0) +
          stat('Contributors confirming', s.contributors || 0) +
          stat('Newest submission', newest) +
          stat('Oldest current matching', oldest) +
          stat('Conflicting values', s.hasConflict ? 'Yes — reports disagree' : 'No') +
          stat('Source supplied', s.sourceUrl ? payPlanLink('View pay plan ↗') : 'No') +
          stat('Department maintained', s.departmentMaintained ? 'Yes' : 'No') +
        '</div>' +
        '<div>' +
          '<p class="muted">' + UI.esc(s.confidence.description) + '</p>' +
          '<div class="gate" id="dept-gate"><span aria-hidden="true">🔒</span><div>Sign in with a verified email to confirm, update, or dispute this information. <a href="/sign-in.html">Sign in →</a></div></div>' +
          '<div class="confidence-actions">' +
            '<button class="btn btn-secondary btn-sm" id="act-confirm">👍 This looks correct</button>' +
            '<a class="btn btn-primary btn-sm" href="/submit.html?dept=' + UI.esc(dept.slug) + '&mode=update">Submit an update</a>' +
            '<button class="btn btn-outline btn-sm" id="act-dispute">⚑ Report incorrect information</button>' +
            '<a class="btn btn-outline btn-sm" href="/submit.html?dept=' + UI.esc(dept.slug) + '&mode=step">Add missing pay step</a>' +
          '</div>' +
          '<div id="act-status" class="field-hint" style="margin-top:.6rem"></div>' +
          '<div id="dispute-form"></div>' +
        '</div>' +
      '</div>';
  }
  function stat(k, v) { return '<div class="conf-stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
  function fieldValue(field) { return field === 'top' ? summary.topBase : field === 'midpoint' ? summary.midpoint : summary.entry; }

  // ---- Revision history (public; no emails) ----
  function renderRevisions() {
    var host = document.getElementById('revision-history');
    if (!host) return;
    var reports = ((dept.salary && dept.salary.reports) || []).slice();
    if (!reports.length) { host.innerHTML = ''; return; }
    reports.sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });
    var currentVal = summary.entry;
    host.innerHTML = '<h2>Revision history</h2>' +
      '<p class="muted">Every submission is preserved. Contributor identities are shown by type only.</p>' +
      reports.map(function (r, i) {
        var isCurrent = i === 0;
        var type = r.departmentMaintained ? 'Department representative' : 'Community contributor';
        return '<div class="revision' + (isCurrent ? '' : ' superseded') + '">' +
          '<div class="rev-head"><strong>' + UI.esc(r.submittedAt) + '</strong>' +
            '<span class="pill">' + type + '</span>' +
            (r.hasSource ? '<span class="pill">' + payPlanLink('Pay plan ↗', 'Source on file') + '</span>' : '') +
            '<span class="chip ' + (isCurrent ? 'current' : 'needed') + '"><span class="chip-icon">' + (isCurrent ? '◉' : '○') + '</span>' + (isCurrent ? 'Current' : 'Superseded') + '</span>' +
          '</div>' +
          '<div class="rev-diff">Reported entry firefighter pay: <span class="new">' + UI.money(r.entry) + '</span>' + (r.top != null ? ' · top ' + UI.money(r.top) : '') + '</div>' +
        '</div>';
      }).join('');
  }

  // ---- Actions ----
  function wireActions() {
    var confirmBtn = document.getElementById('act-confirm');
    var disputeBtn = document.getElementById('act-dispute');
    var gate = document.getElementById('dept-gate');
    var statusEl = document.getElementById('act-status');

    function requireAuth() {
      if (A && A.canContribute()) return true;
      if (gate) gate.classList.add('show');
      if (!window.FireDB || !window.FireDB.configured) {
        if (statusEl) statusEl.textContent = 'Contributions require a connected Firebase project (not configured in this preview).';
      }
      return false;
    }

    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      if (!requireAuth()) return;
      writeConfirmation().then(function () { statusEl.textContent = 'Thanks — your confirmation was recorded.'; confirmBtn.disabled = true; })
        .catch(function (e) { statusEl.textContent = 'Could not record confirmation: ' + e.message; });
    });

    if (disputeBtn) disputeBtn.addEventListener('click', function () {
      if (!requireAuth()) return;
      var form = document.getElementById('dispute-form');
      var fieldOpts = DISPUTE_FIELDS.filter(function (f) { return fieldValue(f[0]) != null; })
        .map(function (f) { return '<option value="' + f[0] + '">' + f[1] + ' (' + UI.money(fieldValue(f[0])) + ')</option>'; }).join('');
      form.innerHTML = '<div class="card card-tight" style="margin-top:.6rem">' +
        '<div class="field"><label for="dfield">Which figure is wrong?</label><select id="dfield">' + fieldOpts + '</select></div>' +
        '<div class="field"><label for="dv">Corrected amount</label><input id="dv" type="number" inputmode="numeric" placeholder="$"></div>' +
        '<div class="field"><label for="dr">What is wrong?</label><textarea id="dr" placeholder="Explain what should change and how you know."></textarea></div>' +
        '<button class="btn btn-primary btn-sm" id="dsub">Submit dispute</button></div>';
      document.getElementById('dsub').addEventListener('click', function () {
        var field = document.getElementById('dfield').value, val = document.getElementById('dv').value, reason = document.getElementById('dr').value;
        writeDispute(field, val, reason).then(function () { form.innerHTML = '<p class="field-hint">Thanks — your dispute was submitted and is now visible with the record.</p>'; })
          .catch(function (e) { statusEl.textContent = 'Could not submit dispute: ' + e.message; });
      });
    });
  }

  // Captures the currently-displayed entry/midpoint/top figures at confirmation
  // time — export-overlay.js folds this into the same report pool as an
  // ordinary submission agreeing with the current value, so a confirmation
  // actually strengthens the consensus cluster (and finally makes "Contributors
  // confirming" mean what it says) instead of being written and never read.
  async function writeConfirmation() {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    var doc = { departmentSlug: dept.slug, contributorId: A.user.uid, confirmationType: 'looks_correct', createdAt: F.serverTimestamp() };
    if (summary.entry != null) doc.confirmedEntry = summary.entry;
    if (summary.midpoint != null) doc.confirmedMidpoint = summary.midpoint;
    if (summary.topBase != null) doc.confirmedTop = summary.topBase;
    await F.addDoc(F.collection(db.db, 'confirmations'), doc);
  }
  async function writeDispute(field, value, reason) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    await F.addDoc(F.collection(db.db, 'disputes'), {
      departmentSlug: dept.slug, field: field, disputedValue: fieldValue(field),
      proposedValue: Lib.parseMoney(value), contributorId: A.user.uid, reason: String(reason || '').slice(0, 1000),
      status: 'open', createdAt: F.serverTimestamp()
    });
  }

  // ---- Flag a specific pay-step plan (distinct from the generic "entry" dispute
  // above) — targets the exact live submission the "Pay-step plan" table is
  // currently showing. A single flag doesn't hide it; scripts/export-overlay.js
  // only reverts to the next most recent plan once enough distinct community
  // members have flagged this same submission (default: 3). ----
  function wireStepPlanFlag() {
    var btn = document.getElementById('flag-step-plan');
    if (!btn || btn._wired) return;
    btn._wired = true;
    var host = document.getElementById('flag-step-plan-status');
    var stepPlanId = btn.getAttribute('data-step-plan-id');
    btn.addEventListener('click', function () {
      if (!(A && A.canContribute())) {
        host.innerHTML = (window.FireDB && window.FireDB.configured)
          ? '<a href="/sign-in.html">Sign in with a verified email</a> to flag this pay-step plan.'
          : 'Flagging requires a connected Firebase project (not configured in this preview).';
        return;
      }
      host.innerHTML = '<div class="card card-tight" style="margin-top:.5rem">' +
        '<div class="field"><label for="fpr">What looks wrong with this pay-step plan?</label><textarea id="fpr" placeholder="Explain what should change and how you know."></textarea></div>' +
        '<button class="btn btn-primary btn-sm" id="fpsub">Submit flag</button></div>';
      document.getElementById('fpsub').addEventListener('click', function () {
        var reason = document.getElementById('fpr').value;
        writeStepPlanDispute(stepPlanId, reason).then(function () {
          host.innerHTML = '<p class="field-hint">Thanks — this flag was recorded. The plan stays visible, marked disputed, unless enough other community members flag it too.</p>';
          btn.disabled = true;
        }).catch(function (e) { host.innerHTML = '<p class="field-error">Could not submit: ' + UI.esc(e.message) + '</p>'; });
      });
    });
  }

  async function writeStepPlanDispute(stepPlanId, reason) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    await F.addDoc(F.collection(db.db, 'disputes'), {
      departmentSlug: dept.slug, field: 'stepPlan', disputedSubmissionId: stepPlanId,
      reason: String(reason || '').slice(0, 1000), contributorId: A.user.uid, status: 'open', createdAt: F.serverTimestamp()
    });
  }
})();
