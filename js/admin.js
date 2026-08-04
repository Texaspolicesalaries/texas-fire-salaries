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
      q('q-dupes', 'Possible duplicate departments', 'Suggested merges from contributors.') +
      '<div class="card"><h3>Management tools</h3><p class="muted">Merge duplicates · correct names · adjust coordinates · lock fields · restore revisions · manage approved email domains · suspend/restore users. <span class="pill">Phase 3</span></p></div>';
  }

  async function loadQueues() {
    var db = window.FireDB; if (!db || !db.ready) return;
    var F = db.sdk.firestore;
    await fillFlaggedQueue(F);
    await fillDisputesQueue(F);
    await fillQueue('q-claims', F, 'department_claims', [F.where('status', '==', 'pending')], function (d) { return (d.departmentSlug || '') + ' — ' + (d.emailDomain || ''); });
    await fillDupesQueue(F);
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
