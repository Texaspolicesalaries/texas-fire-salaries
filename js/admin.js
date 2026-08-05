/*
 * admin.js — Low-maintenance admin dashboard (SCAFFOLD).
 *
 * Phase 1 renders the overview counts from seed + Firestore and lays out the
 * moderation queues so the owner mainly handles spam/abuse/claims — routine
 * submissions never queue here. Queue actions (merge, lock, restore, suspend)
 * are stubbed with clear "Phase 3" markers; the data model + rules already
 * support them. Access is gated to the admin role.
 */
(function () {
  'use strict';
  var UI = window.FireUI, D = window.FireData, A = window.FireAuth;

  document.addEventListener('DOMContentLoaded', function () {
    D.load().then(gate);
    if (A) A.onChange(gate);
  });

  function gate() {
    var host = document.getElementById('admin-body');
    if (!host) return;
    if (!window.FireDB || !window.FireDB.configured) {
      host.innerHTML = card('Connect Firebase', '<p class="muted">The admin dashboard reads live moderation data from Firestore. Add your Firebase config to <span class="mono">js/firebase-init.js</span> to enable it. Overview metrics below use seed data as a preview.</p>') + overview();
      return;
    }
    if (!(A && A.isAdmin())) {
      host.innerHTML = '<div class="notice warn"><span class="notice-icon">🔒</span><div>Admin access only. <a href="/sign-in.html">Sign in</a> with an administrator account.</div></div>';
      return;
    }
    host.innerHTML = overview() + queues();
    loadQueues();
  }

  function overview() {
    var all = D.all();
    var withData = all.filter(function (d) { return d.summary.hasSalary; });
    var current = withData.filter(function (d) { return within(d.summary.lastUpdated, 12); });
    var conflicting = withData.filter(function (d) { return d.summary.hasConflict; });
    var stat = function (n, l) { return '<div class="card stat-card"><div class="stat-val">' + n + '</div><div class="stat-lab">' + l + '</div></div>'; };
    return '<h2>Overview</h2><div class="grid cols-4" style="margin-bottom:2rem">' +
      stat(all.length, 'Total departments') +
      stat(current.length, 'Departments with current data') +
      stat(all.length - withData.length, 'Departments needing updates') +
      stat(conflicting.length, 'Conflicting records') +
      '</div>';
  }

  function queues() {
    var q = function (id, title, hint) {
      return '<div class="card" style="margin-bottom:1rem"><h3>' + title + '</h3><p class="muted" style="margin-bottom:.75rem">' + hint + '</p><div id="' + id + '"><p class="field-hint">Loading…</p></div></div>';
    };
    return '<h2>Moderation queues</h2>' +
      '<p class="muted" style="margin-bottom:1rem">Routine salary submissions publish automatically and do <strong>not</strong> appear here — only automatically flagged items and reports do.</p>' +
      q('q-flagged', 'Flagged submissions', 'Auto-flagged by the moderation rules (large jumps, out-of-range, placeholder data).') +
      q('q-disputes', 'Disputes & abuse reports', 'Community-reported incorrect information and abuse reports.') +
      q('q-claims', 'Department ownership claims', 'Requests to manage a department page via an official email domain.') +
      '<div class="card" style="margin-bottom:1rem"><h3>Active department claims</h3>' +
      '<p class="muted" style="margin-bottom:.75rem">Approved right now. A claim expires automatically after 18 months with no submission from the claimant — revoke here if it needs to happen sooner, or reassign it to a different department if it was granted by mistake.</p>' +
      '<div id="q-active-claims"><p class="field-hint">Loading…</p></div>' +
      '<div class="divider-label" style="margin:1rem 0">Grant a claim manually</div>' +
      '<p class="field-hint" style="margin-bottom:.5rem">Only finds people who have submitted at least one claim before (even a rejected one) — there is no way to look up an arbitrary email that has never touched a claim.</p>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="ac-dept">Department</label><input id="ac-dept" type="text" list="ac-dept-list" autocomplete="off" placeholder="Type a department, city, or county…"><datalist id="ac-dept-list"></datalist></div>' +
        '<div class="field"><label for="ac-user">Claimant</label><select id="ac-user"><option value="">Loading…</option></select></div>' +
      '</div>' +
      '<button class="btn btn-outline btn-sm" id="ac-add">Grant claim</button>' +
      '<div id="ac-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>' +
      q('q-dupes', 'Possible duplicate departments', 'Suggested merges from contributors.') +
      '<div class="card"><h3>Management tools</h3><p class="muted">Merge duplicates · correct names · adjust coordinates · lock fields · restore revisions · manage approved email domains · suspend/restore users. <span class="pill">Phase 3</span></p></div>';
  }

  async function loadQueues() {
    var db = window.FireDB; if (!db || !db.ready) return;
    var F = db.sdk.firestore;
    await fillFlaggedQueue(F);
    await fillDisputesQueue(F);
    await fillClaimsQueue(F);
    await fillActiveClaimsQueue(F);
    wireAddClaimForm(F);
    await fillDupesQueue(F);
  }

  // Department claims — js/department.js's "Claim this department" now writes
  // real pending requests. Approving does two things: sets the claim's own
  // status (which scripts/export-overlay.js's queryApprovedClaimSlugs reads on
  // its next run to show the "Department maintained" badge), AND flips the
  // requester's own users/{uid} doc to role:'department' so their FUTURE
  // submissions are correctly labeled "Department representative" in revision
  // history — two separate writes, not atomic, but low-risk (worst case an
  // admin retries one manually).
  async function fillClaimsQueue(F) {
    var el = document.getElementById('q-claims'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_claims'), F.where('status', '==', 'pending'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var deptLink = d.departmentSlug
          ? '<a href="/departments/' + UI.esc(d.departmentSlug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentSlug) + '</a>'
          : 'unknown department';
        // Older claims (written before email was captured) only have
        // emailDomain — fall back to that rather than showing nothing.
        var who = d.email || (d.emailDomain ? ('someone @' + d.emailDomain) : 'unknown email');
        rows.push('<div class="feed-item"><span>' + deptLink + ' — claimed by ' + UI.esc(who) + '</span>' +
          '<span class="feed-when">' +
          '<button class="btn btn-secondary btn-sm" data-claim-id="' + UI.esc(doc.id) + '" data-claim-action="approve" data-claim-user="' + UI.esc(d.userId || '') + '">Approve</button> ' +
          '<button class="btn btn-outline btn-sm" data-claim-id="' + UI.esc(doc.id) + '" data-claim-action="reject">Reject</button>' +
          '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-claim-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          resolveClaim(F, btn.getAttribute('data-claim-id'), btn.getAttribute('data-claim-action'), btn.getAttribute('data-claim-user'), btn);
        });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function resolveClaim(F, id, action, userId, btn) {
    var item = btn.closest('.feed-item');
    var buttons = item ? item.querySelectorAll('button') : [btn];
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      // resolvedAt is the baseline scripts/export-overlay.js's
      // computeActiveClaimants() gives a freshly-approved claimant to submit
      // something before treating them as expired — without it, a claim
      // approved today with no submission yet would look infinitely stale.
      await F.updateDoc(F.doc(window.FireDB.db, 'department_claims', id), {
        status: action === 'approve' ? 'approved' : 'rejected', resolvedAt: F.serverTimestamp()
      });
    } catch (e) {
      buttons.forEach(function (b) { b.disabled = false; });
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not update: ' + e.message;
      if (item) item.appendChild(err);
      return;
    }
    if (action === 'approve' && userId) {
      try {
        await F.updateDoc(F.doc(window.FireDB.db, 'users', userId), { role: 'department' });
      } catch (e) {
        // The claim itself is already approved (the "Department maintained" badge
        // will show on the next overlay refresh) — but granting the requester's
        // account the 'department' role failed. Don't remove the row: the claim
        // update above is idempotent, so clicking Approve again safely retries
        // just this step instead of the failure silently vanishing.
        buttons.forEach(function (b) { b.disabled = false; });
        var warn = document.createElement('div');
        warn.className = 'field-error'; warn.style.marginTop = '.3rem';
        warn.textContent = 'Claim approved, but granting the department role failed: ' + e.message + ' — click Approve again to retry.';
        if (item) item.appendChild(warn);
        return;
      }
    }
    if (item) item.remove();
  }

  // "Remove" for an approved claim. Also expires automatically after 18
  // months of claimant inactivity (scripts/export-overlay.js's
  // computeActiveClaimants) — this is for revoking sooner than that, or
  // undoing a mistake. "Edit" is handled as revoke-then-re-grant below rather
  // than a separate inline-edit control, since granting already needs the
  // same department/claimant pickers.
  async function fillActiveClaimsQueue(F) {
    var el = document.getElementById('q-active-claims'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_claims'), F.where('status', '==', 'approved'), F.limit(50));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">No active claims.</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var slug = d.departmentSlug || '';
        var deptLink = slug
          ? '<a href="/departments/' + UI.esc(slug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentName || slug) + '</a>'
          : 'unknown department';
        var who = d.email || (d.emailDomain ? ('someone @' + d.emailDomain) : 'unknown email');
        rows.push('<div class="feed-item"><span>' + deptLink + ' — ' + UI.esc(who) + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-revoke-id="' + UI.esc(doc.id) + '" data-revoke-user="' + UI.esc(d.userId || '') + '">Revoke</button></span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-revoke-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          revokeClaim(F, btn.getAttribute('data-revoke-id'), btn.getAttribute('data-revoke-user'), btn);
        });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function revokeClaim(F, id, userId, btn) {
    var item = btn.closest('.feed-item');
    var buttons = item ? item.querySelectorAll('button') : [btn];
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      await F.updateDoc(F.doc(window.FireDB.db, 'department_claims', id), { status: 'revoked', resolvedAt: F.serverTimestamp() });
    } catch (e) {
      buttons.forEach(function (b) { b.disabled = false; });
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not revoke: ' + e.message;
      if (item) item.appendChild(err);
      return;
    }
    if (userId) {
      try {
        await F.updateDoc(F.doc(window.FireDB.db, 'users', userId), { role: 'contributor' });
      } catch (e) {
        // Same non-atomic tradeoff as approving: the claim itself is already
        // revoked, but reverting their role failed — keep the row so Revoke
        // can be clicked again to retry just that step.
        buttons.forEach(function (b) { b.disabled = false; });
        var warn = document.createElement('div');
        warn.className = 'field-error'; warn.style.marginTop = '.3rem';
        warn.textContent = 'Claim revoked, but reverting the user\'s role failed: ' + e.message + ' — click Revoke again to retry.';
        if (item) item.appendChild(warn);
        return;
      }
    }
    if (item) item.remove();
  }

  // Same "Name — City" match-as-you-type pattern as js/submit.js's
  // matchDept(), so admins search departments the same way contributors do.
  function matchDept(text) {
    text = String(text || '').toLowerCase().trim(); if (!text) return null;
    var all = D.all();
    return all.find(function (d) { return (d.name + ' — ' + d.city).toLowerCase() === text; }) ||
      all.find(function (d) { return d.name.toLowerCase().indexOf(text) !== -1 || (d.city && d.city.toLowerCase().indexOf(text) !== -1) || (d.county && d.county.toLowerCase().indexOf(text) !== -1); });
  }

  // Only surfaces people who have submitted at least one claim before (any
  // status) — there is no way to resolve an arbitrary email to a Firebase uid
  // client-side without the Admin SDK, which this credential-free project
  // deliberately doesn't use. Good enough for "grant them a second
  // department too" or "redo a claim that was entered wrong"; someone who
  // has never touched the claim flow has to submit one (even a fresh pending
  // one an admin then approves) before they can be found here.
  async function fetchClaimantDirectory(F) {
    var snap = await F.getDocs(F.query(F.collection(window.FireDB.db, 'department_claims'), F.limit(200)));
    var byUser = {};
    snap.forEach(function (doc) {
      var d = doc.data();
      if (!d.userId) return;
      var prior = byUser[d.userId];
      byUser[d.userId] = { userId: d.userId, email: d.email || (prior && prior.email) || '' };
    });
    return Object.keys(byUser).map(function (k) { return byUser[k]; });
  }

  async function grantClaim(F, dept, userId, email) {
    var db = window.FireDB;
    await F.addDoc(F.collection(db.db, 'department_claims'), {
      userId: userId, departmentSlug: dept.slug, departmentName: dept.name, email: email || '',
      status: 'approved', createdAt: F.serverTimestamp(), resolvedAt: F.serverTimestamp()
    });
    // Best-effort, same non-atomic tradeoff as everywhere else here — if this
    // fails the claim still exists and is visible in the active-claims list
    // above, so the admin can tell the role grant needs a manual retry.
    await F.updateDoc(F.doc(db.db, 'users', userId), { role: 'department' });
  }

  async function wireAddClaimForm(F) {
    var deptInput = document.getElementById('ac-dept');
    var deptList = document.getElementById('ac-dept-list');
    var userSelect = document.getElementById('ac-user');
    var addBtn = document.getElementById('ac-add');
    var status = document.getElementById('ac-status');
    if (!deptInput || !deptList || !userSelect || !addBtn) return;
    deptList.innerHTML = D.all().map(function (d) { return '<option value="' + UI.esc(d.name + ' — ' + d.city) + '"></option>'; }).join('');
    try {
      var directory = await fetchClaimantDirectory(F);
      userSelect.innerHTML = '<option value="">Select…</option>' +
        directory.map(function (c) { return '<option value="' + UI.esc(c.userId) + '">' + UI.esc(c.email || c.userId) + '</option>'; }).join('');
    } catch (e) {
      userSelect.innerHTML = '<option value="">Could not load claimants</option>';
    }
    addBtn.addEventListener('click', function () {
      var dept = matchDept(deptInput.value);
      var userId = userSelect.value;
      if (!dept) { status.innerHTML = '<span class="field-error">Type a department that matches one in the list.</span>'; return; }
      if (!userId) { status.innerHTML = '<span class="field-error">Select a claimant.</span>'; return; }
      var email = userSelect.options[userSelect.selectedIndex].textContent;
      status.textContent = ''; addBtn.disabled = true; addBtn.textContent = 'Granting…';
      grantClaim(F, dept, userId, email).then(function () {
        status.textContent = 'Granted — ' + email + ' is now the verified contact for ' + dept.name + '.';
        deptInput.value = ''; userSelect.value = '';
        fillActiveClaimsQueue(F);
      }).catch(function (e) {
        status.innerHTML = '<span class="field-error">Could not grant: ' + UI.esc(e.message) + '</span>';
      }).then(function () { addBtn.disabled = false; addBtn.textContent = 'Grant claim'; });
    });
  }

  // Possible-duplicate department requests get real data now too — js/submit.js's
  // isDuplicateDept() checks a new "Add a department" submission against
  // existing departments AT CREATE TIME and sets its own initial status, since
  // department_requests only lets isAdmin() update an existing doc (the earlier
  // idea of flagging this from the credential-free export script was blocked by
  // that same rule). Two outcomes here, since force-publishing a genuine
  // duplicate would put a second pin on the map for the same place: publish it
  // (false alarm) or reject it (confirmed duplicate, never promoted).
  async function fillDupesQueue(F) {
    var el = document.getElementById('q-dupes'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_requests'), F.where('status', '==', 'possible_duplicate'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var loc = [d.city, d.county].filter(Boolean).join(', ');
        rows.push('<div class="feed-item"><span>' + UI.esc(d.name || '(unnamed)') + (loc ? ' — ' + UI.esc(loc) : '') + '</span>' +
          '<span class="feed-when">' +
          '<button class="btn btn-secondary btn-sm" data-dupe-id="' + UI.esc(doc.id) + '" data-dupe-action="publish">Not a duplicate — publish</button> ' +
          '<button class="btn btn-outline btn-sm" data-dupe-id="' + UI.esc(doc.id) + '" data-dupe-action="reject">Confirm duplicate</button>' +
          '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-dupe-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { resolveDupe(F, btn.getAttribute('data-dupe-id'), btn.getAttribute('data-dupe-action'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function resolveDupe(F, id, action, btn) {
    var item = btn.closest('.feed-item');
    var buttons = item ? item.querySelectorAll('button') : [btn];
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      await F.updateDoc(F.doc(window.FireDB.db, 'department_requests', id), { status: action === 'publish' ? 'published' : 'rejected' });
      if (item) item.remove();
    } catch (e) {
      buttons.forEach(function (b) { b.disabled = false; });
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not update: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  // Flagged submissions get their own renderer too, same reasoning as disputes:
  // js/submit.js's computeAutomatedFlags() now actually writes status:'flagged'
  // (out-of-range or large-jump figures), so this queue has real data for the
  // first time — an "Approve" action publishes it, closing the loop instead of
  // leaving a flagged submission stuck forever with no way to review it.
  async function fillFlaggedQueue(F) {
    var el = document.getElementById('q-flagged'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'submissions'), F.where('status', '==', 'flagged'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var deptLink = d.departmentSlug
          ? '<a href="/departments/' + UI.esc(d.departmentSlug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentSlug) + '</a>'
          : 'unknown department';
        var reasons = (d.automatedFlags || []).join('; ') || 'flagged';
        rows.push('<div class="feed-item"><span>' + deptLink + ' — ' + UI.esc(reasons) + '</span>' +
          '<span class="feed-when"><button class="btn btn-secondary btn-sm" data-approve-id="' + UI.esc(doc.id) + '">Approve</button></span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-approve-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { approveSubmission(F, btn.getAttribute('data-approve-id'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function approveSubmission(F, id, btn) {
    var item = btn.closest('.feed-item');
    var oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Approving…';
    try {
      await F.updateDoc(F.doc(window.FireDB.db, 'submissions', id), { status: 'published' });
      if (item) item.remove();
    } catch (e) {
      btn.disabled = false; btn.textContent = oldLabel;
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not approve: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  // Disputes gets its own queue renderer (not the generic fillQueue) because it's
  // the one queue with real, live data right now (step-plan flags and
  // entry/top/midpoint disputes both write here — see js/department.js) and the
  // only one that needs an action: resolving a dispute sets its status away from
  // 'open', which is exactly the filter scripts/export-overlay.js's
  // countStepPlanDisputes/countValueDisputes use, so a resolved dispute stops
  // counting toward the revert threshold on the next scheduled refresh.
  function disputeLabel(d) {
    var deptLink = d.departmentSlug
      ? '<a href="/departments/' + UI.esc(d.departmentSlug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentSlug) + '</a>'
      : 'unknown department';
    var what = d.field === 'stepPlan'
      ? 'pay-step plan flagged'
      : (d.field || 'entry') + ' disputed (' + (d.disputedValue != null ? '$' + d.disputedValue : '?') + (d.proposedValue != null ? ' → $' + d.proposedValue : '') + ')';
    return deptLink + ' — ' + what + (d.reason ? ': ' + UI.esc(String(d.reason).slice(0, 80)) : '');
  }

  async function fillDisputesQueue(F) {
    var el = document.getElementById('q-disputes'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'disputes'), F.where('status', '==', 'open'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        rows.push('<div class="feed-item"><span>' + disputeLabel(doc.data()) + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-dispute-id="' + UI.esc(doc.id) + '">Resolve</button></span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-dispute-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { resolveDispute(F, btn.getAttribute('data-dispute-id'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function resolveDispute(F, id, btn) {
    var item = btn.closest('.feed-item');
    var oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Resolving…';
    try {
      await F.updateDoc(F.doc(window.FireDB.db, 'disputes', id), {
        status: 'resolved', resolvedAt: F.serverTimestamp(), resolvedBy: (A && A.user && A.user.uid) || null
      });
      if (item) item.remove();
    } catch (e) {
      btn.disabled = false; btn.textContent = oldLabel;
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not resolve: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  async function fillQueue(id, F, coll, wheres, label) {
    var el = document.getElementById(id); if (!el) return;
    try {
      var qy = F.query.apply(null, [F.collection(window.FireDB.db, coll)].concat(wheres, [F.limit(25)]));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) { rows.push('<div class="feed-item"><span>' + UI.esc(label(doc.data())) + '</span><span class="feed-when"><span class="pill">review</span></span></div>'); });
      el.innerHTML = rows.join('');
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  function within(ms, months) { return ms && (Date.now() - ms) <= months * 30.437 * 24 * 3600 * 1000; }
  function card(title, body) { return '<div class="card" style="margin-bottom:1.5rem"><h3>' + title + '</h3>' + body + '</div>'; }
})();
