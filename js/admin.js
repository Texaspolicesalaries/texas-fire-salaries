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
  var UI = window.FireUI, D = window.FireData, A = window.FireAuth, Lib = window.FireSalaryLib;

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
    host.innerHTML = overview() + analyticsCard() + queues();
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

  // ---- Analytics (js/analytics.js writes; last 30 days, admin-only read) ----
  var ANALYTICS_WINDOW_DAYS = 30;
  function analyticsCard() {
    return '<h2>Analytics <span class="field-hint">(last ' + ANALYTICS_WINDOW_DAYS + ' days)</span></h2>' +
      '<div id="analytics-body" style="margin-bottom:2rem"><p class="field-hint">Loading…</p></div>';
  }

  async function fillAnalytics(F) {
    var host = document.getElementById('analytics-body'); if (!host) return;
    try {
      var cutoff = new Date(Date.now() - ANALYTICS_WINDOW_DAYS * 24 * 3600 * 1000);
      var qy = F.query(F.collection(window.FireDB.db, 'events'),
        F.where('timestamp', '>=', cutoff), F.orderBy('timestamp', 'desc'), F.limit(500));
      var snap = await F.getDocs(qy);
      if (snap.empty) { host.innerHTML = '<p class="field-hint">No events recorded yet.</p>'; return; }
      var byType = {}, byDept = {}, byQuery = {}, byDay = {};
      snap.forEach(function (doc) {
        var d = doc.data();
        byType[d.type] = (byType[d.type] || 0) + 1;
        if (d.type === 'department_view' && d.departmentSlug) byDept[d.departmentSlug] = (byDept[d.departmentSlug] || 0) + 1;
        if (d.type === 'search' && d.query) byQuery[d.query] = (byQuery[d.query] || 0) + 1;
        if (d.date) byDay[d.date] = (byDay[d.date] || 0) + 1;
      });
      var top = function (obj, n) {
        return Object.keys(obj).map(function (k) { return { k: k, n: obj[k] }; })
          .sort(function (a, b) { return b.n - a.n; }).slice(0, n);
      };
      var TYPE_LABELS = { department_view: 'Department views', search: 'Searches', compare_add: 'Added to comparison', submit_complete: 'Submissions completed' };
      var typeStats = Object.keys(byType).map(function (t) {
        return '<div class="card stat-card"><div class="stat-val">' + byType[t] + '</div><div class="stat-lab">' + (TYPE_LABELS[t] || t) + '</div></div>';
      }).join('');
      var deptRows = top(byDept, 8).map(function (row) {
        return '<div class="feed-item"><span><a href="/departments/' + UI.esc(row.k) + '/" target="_blank" rel="noopener">' + UI.esc(row.k) + '</a></span><span class="feed-when">' + row.n + ' view' + (row.n === 1 ? '' : 's') + '</span></div>';
      }).join('') || '<p class="field-hint">No department views yet.</p>';
      var queryRows = top(byQuery, 8).map(function (row) {
        return '<div class="feed-item"><span>' + UI.esc(row.k) + '</span><span class="feed-when">' + row.n + '×</span></div>';
      }).join('') || '<p class="field-hint">No searches yet.</p>';
      var days = Object.keys(byDay).sort().slice(-14);
      var maxDay = Math.max.apply(null, days.map(function (d) { return byDay[d]; }).concat(1));
      var dayBars = days.map(function (d) {
        var pct = Math.max(4, Math.round((byDay[d] / maxDay) * 100));
        return '<div class="feed-item"><span>' + d + '</span><span class="feed-when" style="display:flex;align-items:center;gap:.5rem">' +
          '<span style="display:inline-block;width:80px;height:8px;border-radius:4px;background:var(--bg-sunken);overflow:hidden">' +
          '<span style="display:block;height:100%;width:' + pct + '%;background:var(--accent)"></span></span>' + byDay[d] + '</span></div>';
      }).join('');
      host.innerHTML =
        '<div class="grid cols-4" style="margin-bottom:1rem">' + typeStats + '</div>' +
        '<div class="grid cols-2">' +
          '<div class="card"><h3>Most-viewed departments</h3>' + deptRows + '</div>' +
          '<div class="card"><h3>Top searches</h3>' + queryRows + '</div>' +
        '</div>' +
        '<div class="card" style="margin-top:1rem"><h3>Events per day</h3>' + dayBars + '</div>';
    } catch (e) {
      host.innerHTML = '<p class="field-hint">Analytics unavailable: ' + UI.esc(e.message) + '</p>';
    }
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
      q('q-location', 'Departments needing a location check', 'The ZIP could not be resolved to a Texas place, or it belongs to a different city than the one entered. Nothing here is on the map yet.') +
      suspendedCard() + deptOverrideCard() + fieldLockCard() + approvedDomainsCard();
  }

  // ---- Suspend / restore contributors ----
  function suspendedCard() {
    return '<div class="card" style="margin-bottom:1rem"><h3>Suspended contributors</h3>' +
      '<p class="muted" style="margin-bottom:.75rem">A suspended contributor\'s reports — past and future — are excluded from consensus, and new submissions/disputes/claims are blocked at the rules level. Use "Suspend" on a flagged submission or dispute above, or enter a contributor ID directly.</p>' +
      '<div id="q-suspended"><p class="field-hint">Loading…</p></div>' +
      '<div class="divider-label" style="margin:1rem 0">Suspend by contributor ID</div>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="susp-id">Contributor ID</label><input id="susp-id" type="text" placeholder="Firebase uid — copy from a queue item above"></div>' +
        '<div class="field"><label for="susp-reason">Reason (admin note, not shown to the public)</label><input id="susp-reason" type="text" placeholder="Why this contributor is suspended"></div>' +
      '</div>' +
      '<button class="btn btn-outline btn-sm" id="susp-add">Suspend</button>' +
      '<div id="susp-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>';
  }

  async function fillSuspendedQueue(F) {
    var el = document.getElementById('q-suspended'); if (!el) return;
    try {
      var snap = await F.getDocs(F.query(F.collection(window.FireDB.db, 'suspended_contributors'), F.limit(100)));
      if (snap.empty) { el.innerHTML = '<p class="field-hint">No suspended contributors.</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        rows.push('<div class="feed-item"><span>' + UI.esc(doc.id) + (d.reason ? ' — ' + UI.esc(d.reason) : '') + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-restore-id="' + UI.esc(doc.id) + '">Restore</button></span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-restore-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { restoreContributor(F, btn.getAttribute('data-restore-id'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function suspendContributor(F, userId, reason) {
    await F.setDoc(F.doc(window.FireDB.db, 'suspended_contributors', userId), {
      userId: userId, reason: String(reason || '').slice(0, 300),
      suspendedAt: F.serverTimestamp(), suspendedBy: (A && A.user && A.user.email) || null
    });
  }

  async function restoreContributor(F, userId, btn) {
    var item = btn.closest('.feed-item');
    btn.disabled = true;
    try {
      await F.deleteDoc(F.doc(window.FireDB.db, 'suspended_contributors', userId));
      if (item) item.remove();
    } catch (e) {
      btn.disabled = false;
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not restore: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  function wireSuspendForm(F) {
    var idInput = document.getElementById('susp-id');
    var reasonInput = document.getElementById('susp-reason');
    var btn = document.getElementById('susp-add');
    var status = document.getElementById('susp-status');
    if (!idInput || !btn) return;
    btn.addEventListener('click', function () {
      var userId = idInput.value.trim();
      if (!userId) { status.innerHTML = '<span class="field-error">Enter a contributor ID.</span>'; return; }
      btn.disabled = true; btn.textContent = 'Suspending…';
      suspendContributor(F, userId, reasonInput.value).then(function () {
        status.textContent = 'Suspended ' + userId + '.';
        idInput.value = ''; reasonInput.value = '';
        fillSuspendedQueue(F);
      }).catch(function (e) {
        status.innerHTML = '<span class="field-error">Could not suspend: ' + UI.esc(e.message) + '</span>';
      }).then(function () { btn.disabled = false; btn.textContent = 'Suspend'; });
    });
  }

  // ---- Department details: name/coordinate corrections + duplicate merges ----
  function deptOverrideCard() {
    return '<div class="card" style="margin-bottom:1rem"><h3>Department details</h3>' +
      '<p class="muted" style="margin-bottom:.75rem">Correct a department\'s display name or map coordinates, or mark it as a duplicate that should redirect to another department\'s page (a 301, so any links/bookmarks to the old page still work).</p>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="do-dept">Department</label><input id="do-dept" type="text" list="do-dept-list" autocomplete="off" placeholder="Type a department, city, or county…"><datalist id="do-dept-list"></datalist></div>' +
        '<div class="field"><label for="do-name">Corrected name (optional)</label><input id="do-name" type="text" placeholder="Leave blank to keep as-is"></div>' +
        '<div class="field"><label for="do-lat">Corrected latitude (optional)</label><input id="do-lat" type="number" step="any" placeholder="e.g. 32.96"></div>' +
        '<div class="field"><label for="do-lng">Corrected longitude (optional)</label><input id="do-lng" type="number" step="any" placeholder="e.g. -96.83"></div>' +
        '<div class="field"><label for="do-merge">Merge into (optional — makes this a duplicate)</label><input id="do-merge" type="text" list="do-dept-list" autocomplete="off" placeholder="The department this one should redirect to"></div>' +
      '</div>' +
      '<button class="btn btn-outline btn-sm" id="do-save">Save</button>' +
      '<div id="do-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>';
  }

  function wireDeptOverrideForm(F) {
    var deptInput = document.getElementById('do-dept');
    var deptList = document.getElementById('do-dept-list');
    var nameInput = document.getElementById('do-name');
    var latInput = document.getElementById('do-lat');
    var lngInput = document.getElementById('do-lng');
    var mergeInput = document.getElementById('do-merge');
    var saveBtn = document.getElementById('do-save');
    var status = document.getElementById('do-status');
    if (!deptInput || !saveBtn) return;
    deptList.innerHTML = D.all().map(function (d) { return '<option value="' + UI.esc(d.name + ' — ' + d.city) + '"></option>'; }).join('');
    saveBtn.addEventListener('click', function () {
      var dept = matchDept(deptInput.value);
      if (!dept) { status.innerHTML = '<span class="field-error">Type a department that matches one in the list.</span>'; return; }
      var mergeDept = mergeInput.value.trim() ? matchDept(mergeInput.value) : null;
      if (mergeInput.value.trim() && !mergeDept) { status.innerHTML = '<span class="field-error">Merge target doesn\'t match a known department.</span>'; return; }
      if (mergeDept && mergeDept.slug === dept.slug) { status.innerHTML = '<span class="field-error">A department can\'t merge into itself.</span>'; return; }
      var doc = { departmentSlug: dept.slug, updatedAt: F.serverTimestamp(), updatedBy: (A && A.user && A.user.email) || null };
      if (nameInput.value.trim()) doc.name = nameInput.value.trim();
      if (latInput.value !== '') doc.lat = parseFloat(latInput.value);
      if (lngInput.value !== '') doc.lng = parseFloat(lngInput.value);
      if (mergeDept) doc.mergeIntoSlug = mergeDept.slug;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      F.setDoc(F.doc(window.FireDB.db, 'department_overrides', dept.slug), doc, { merge: true }).then(function () {
        status.textContent = 'Saved — takes effect on the next scheduled refresh.';
        deptInput.value = ''; nameInput.value = ''; latInput.value = ''; lngInput.value = ''; mergeInput.value = '';
      }).catch(function (e) {
        status.innerHTML = '<span class="field-error">Could not save: ' + UI.esc(e.message) + '</span>';
      }).then(function () { saveBtn.disabled = false; saveBtn.textContent = 'Save'; });
    });
  }

  // ---- Field locks & one-time corrections ----
  function fieldLockCard() {
    return '<div class="card" style="margin-bottom:1rem"><h3>Field locks &amp; corrections</h3>' +
      '<p class="muted" style="margin-bottom:.75rem">A <strong>locked</strong> value stays fixed regardless of new submissions, until unlocked here. An <strong>unlocked</strong> one-time correction joins the normal report pool instead — it can still be naturally superseded later by fresh community reports, same as any submission.</p>' +
      '<div id="q-field-locks"><p class="field-hint">Loading…</p></div>' +
      '<div class="divider-label" style="margin:1rem 0">Set a value</div>' +
      '<div class="grid cols-2">' +
        '<div class="field"><label for="fl-dept">Department</label><input id="fl-dept" type="text" list="fl-dept-list" autocomplete="off" placeholder="Type a department, city, or county…"><datalist id="fl-dept-list"></datalist></div>' +
        '<div class="field"><label for="fl-field">Field</label><select id="fl-field"><option value="entry">Entry pay</option><option value="midpoint">Midpoint pay</option><option value="top">Top pay</option></select></div>' +
        '<div class="field"><label for="fl-value">Corrected amount</label><input id="fl-value" type="number" inputmode="numeric" placeholder="$"></div>' +
        '<div class="field"><label for="fl-note">Note (shown next to the figure)</label><input id="fl-note" type="text" placeholder="e.g. Verified against the FY26 pay ordinance"></div>' +
      '</div>' +
      '<div class="checkline" style="margin-bottom:.75rem"><input type="checkbox" id="fl-lock"><label for="fl-lock">Lock — keep this value fixed until I unlock it</label></div>' +
      '<button class="btn btn-outline btn-sm" id="fl-save">Save</button>' +
      '<div id="fl-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>';
  }

  async function fillFieldLocksQueue(F) {
    var el = document.getElementById('q-field-locks'); if (!el) return;
    try {
      var snap = await F.getDocs(F.query(F.collection(window.FireDB.db, 'field_locks'), F.limit(100)));
      var active = snap.docs.filter(function (doc) { return doc.data().active !== false; });
      if (!active.length) { el.innerHTML = '<p class="field-hint">No active locks.</p>'; return; }
      var FIELD_LABELS = { entry: 'Entry pay', midpoint: 'Midpoint pay', top: 'Top pay' };
      var rows = active.map(function (doc) {
        var d = doc.data();
        var deptLink = '<a href="/departments/' + UI.esc(d.departmentSlug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentSlug) + '</a>';
        return '<div class="feed-item"><span>' + deptLink + ' — ' + (FIELD_LABELS[d.field] || d.field) + ': $' + UI.esc(d.value) + (d.note ? ' (' + UI.esc(d.note) + ')' : '') + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-unlock-id="' + UI.esc(doc.id) + '">Unlock</button></span></div>';
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-unlock-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { unlockField(F, btn.getAttribute('data-unlock-id'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function unlockField(F, id, btn) {
    var item = btn.closest('.feed-item');
    btn.disabled = true;
    try {
      await F.updateDoc(F.doc(window.FireDB.db, 'field_locks', id), { active: false });
      if (item) item.remove();
    } catch (e) {
      btn.disabled = false;
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not unlock: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  function wireFieldLockForm(F) {
    var deptInput = document.getElementById('fl-dept');
    var deptList = document.getElementById('fl-dept-list');
    var fieldSelect = document.getElementById('fl-field');
    var valueInput = document.getElementById('fl-value');
    var noteInput = document.getElementById('fl-note');
    var lockCheck = document.getElementById('fl-lock');
    var saveBtn = document.getElementById('fl-save');
    var status = document.getElementById('fl-status');
    if (!deptInput || !saveBtn) return;
    deptList.innerHTML = D.all().map(function (d) { return '<option value="' + UI.esc(d.name + ' — ' + d.city) + '"></option>'; }).join('');
    saveBtn.addEventListener('click', function () {
      var dept = matchDept(deptInput.value);
      var value = Lib.parseMoney(valueInput.value);
      if (!dept) { status.innerHTML = '<span class="field-error">Type a department that matches one in the list.</span>'; return; }
      if (value == null) { status.innerHTML = '<span class="field-error">Enter a valid amount.</span>'; return; }
      var field = fieldSelect.value, note = noteInput.value.trim().slice(0, 300);
      var isLock = lockCheck.checked; // captured before the form resets below
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      var write = isLock
        ? F.setDoc(F.doc(window.FireDB.db, 'field_locks', dept.slug + '__' + field), {
            departmentSlug: dept.slug, field: field, value: value, note: note, active: true,
            lockedAt: F.serverTimestamp(), lockedBy: (A && A.user && A.user.email) || null
          })
        : F.addDoc(F.collection(window.FireDB.db, 'admin_corrections'), {
            departmentSlug: dept.slug, field: field, value: value, note: note,
            createdAt: F.serverTimestamp(), createdBy: (A && A.user && A.user.email) || null
          });
      write.then(function () {
        status.textContent = isLock ? 'Locked — takes effect on the next scheduled refresh.' : 'Correction submitted — takes effect on the next scheduled refresh.';
        deptInput.value = ''; valueInput.value = ''; noteInput.value = ''; lockCheck.checked = false;
        if (isLock) fillFieldLocksQueue(F);
      }).catch(function (e) {
        status.innerHTML = '<span class="field-error">Could not save: ' + UI.esc(e.message) + '</span>';
      }).then(function () { saveBtn.disabled = false; saveBtn.textContent = 'Save'; });
    });
  }

  // ---- Approved email domains (reference only — no automation) ----
  function approvedDomainsCard() {
    return '<div class="card"><h3>Approved email domains</h3>' +
      '<p class="muted" style="margin-bottom:.75rem">Reference only — flagging a domain here doesn\'t auto-approve anything, it just makes a matching pending claim easier to recognize in the queue above.</p>' +
      '<div id="q-approved-domains"><p class="field-hint">Loading…</p></div>' +
      '<div class="grid cols-2" style="margin-top:.75rem">' +
        '<div class="field"><label for="ad-domain">Domain</label><input id="ad-domain" type="text" placeholder="e.g. cityofaddison.gov"></div>' +
        '<div class="field"><label for="ad-note">Note (optional)</label><input id="ad-note" type="text" placeholder="e.g. Addison FD official domain"></div>' +
      '</div>' +
      '<button class="btn btn-outline btn-sm" id="ad-add">Add</button>' +
      '<div id="ad-status" class="field-hint" style="margin-top:.5rem"></div>' +
      '</div>';
  }

  async function fillApprovedDomainsQueue(F) {
    var el = document.getElementById('q-approved-domains'); if (!el) return;
    try {
      var snap = await F.getDocs(F.query(F.collection(window.FireDB.db, 'approved_domains'), F.limit(200)));
      if (snap.empty) { el.innerHTML = '<p class="field-hint">No domains added yet.</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        rows.push('<div class="feed-item"><span>' + UI.esc(doc.id) + (d.note ? ' — ' + UI.esc(d.note) : '') + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-remove-domain="' + UI.esc(doc.id) + '">Remove</button></span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-remove-domain]').forEach(function (btn) {
        btn.addEventListener('click', function () { removeApprovedDomain(F, btn.getAttribute('data-remove-domain'), btn); });
      });
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  async function removeApprovedDomain(F, domain, btn) {
    var item = btn.closest('.feed-item');
    btn.disabled = true;
    try {
      await F.deleteDoc(F.doc(window.FireDB.db, 'approved_domains', domain));
      if (item) item.remove();
    } catch (e) {
      btn.disabled = false;
      var err = document.createElement('div');
      err.className = 'field-error'; err.style.marginTop = '.3rem';
      err.textContent = 'Could not remove: ' + e.message;
      if (item) item.appendChild(err);
    }
  }

  function wireApprovedDomainsForm(F) {
    var domainInput = document.getElementById('ad-domain');
    var noteInput = document.getElementById('ad-note');
    var addBtn = document.getElementById('ad-add');
    var status = document.getElementById('ad-status');
    if (!domainInput || !addBtn) return;
    addBtn.addEventListener('click', function () {
      var domain = domainInput.value.trim().toLowerCase().replace(/^@/, '');
      if (!domain || domain.indexOf('.') === -1) { status.innerHTML = '<span class="field-error">Enter a domain like cityofaddison.gov.</span>'; return; }
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      F.setDoc(F.doc(window.FireDB.db, 'approved_domains', domain), {
        note: noteInput.value.trim().slice(0, 200), addedAt: F.serverTimestamp(), addedBy: (A && A.user && A.user.email) || null
      }).then(function () {
        status.textContent = 'Added.';
        domainInput.value = ''; noteInput.value = '';
        fillApprovedDomainsQueue(F);
      }).catch(function (e) {
        status.innerHTML = '<span class="field-error">Could not add: ' + UI.esc(e.message) + '</span>';
      }).then(function () { addBtn.disabled = false; addBtn.textContent = 'Add'; });
    });
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
    await fillLocationQueue(F);
    await fillSuspendedQueue(F);
    wireSuspendForm(F);
    wireDeptOverrideForm(F);
    await fillFieldLocksQueue(F);
    wireFieldLockForm(F);
    await fillApprovedDomainsQueue(F);
    wireApprovedDomainsForm(F);
    await fillAnalytics(F);
  }

  // Cheap client-side hint only — a domain match here never auto-approves
  // anything, it just saves the admin a lookup when a pending claim's email
  // matches a domain they've already flagged as recognized.
  var _approvedDomainsCache = null;
  async function approvedDomainSet(F) {
    if (_approvedDomainsCache) return _approvedDomainsCache;
    try {
      var snap = await F.getDocs(F.query(F.collection(window.FireDB.db, 'approved_domains'), F.limit(200)));
      _approvedDomainsCache = new Set(snap.docs.map(function (doc) { return doc.id; }));
    } catch (e) { _approvedDomainsCache = new Set(); }
    return _approvedDomainsCache;
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
      var approvedDomains = await approvedDomainSet(F);
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var deptLink = d.departmentSlug
          ? '<a href="/departments/' + UI.esc(d.departmentSlug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentSlug) + '</a>'
          : 'unknown department';
        // Older claims (written before email was captured) only have
        // emailDomain — fall back to that rather than showing nothing.
        var who = d.email || (d.emailDomain ? ('someone @' + d.emailDomain) : 'unknown email');
        var recognized = d.emailDomain && approvedDomains.has(d.emailDomain) ? ' <span class="pill">recognized domain</span>' : '';
        rows.push('<div class="feed-item"><span>' + deptLink + ' — claimed by ' + UI.esc(who) + recognized + '</span>' +
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

  // New departments whose ZIP could not be resolved to a Texas place, or whose
  // ZIP belongs to a different city than the one entered (js/submit.js's
  // locationProblem, evaluated at create time — the credential-free export
  // cannot re-status a document). Neither case is proof of anything: a genuine
  // department can sit in an unincorporated area whose post-office city is a
  // neighbouring town, and a brand-new ZIP may simply postdate our table. But
  // an unresolvable ZIP means the export cannot place a pin at all, and a
  // mismatched one is how a department outside Texas would land on the map at
  // some real Texas department's coordinates. So both wait here.
  //
  // Publishing an unresolvable ZIP will still not put it on the map — the
  // export needs coordinates it does not have. Fix the ZIP in Firestore, or add
  // the department to the seed, before publishing that case.
  async function fillLocationQueue(F) {
    var el = document.getElementById('q-location'); if (!el) return;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_requests'), F.where('status', '==', 'location_review'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var why = d.locationReview === 'unknown-zip'
          ? 'ZIP ' + UI.esc(d.zip || '?') + ' is not in the Texas ZIP table'
          : 'ZIP ' + UI.esc(d.zip || '?') + ' is ' + UI.esc(d.zipResolvedCity || 'elsewhere') + ', not ' + UI.esc(d.city || '?');
        rows.push('<div class="feed-item"><span>' + UI.esc(d.name || '(unnamed)') +
          ' — ' + UI.esc([d.city, d.county].filter(Boolean).join(', ')) +
          '<br><small class="muted">' + why + '</small></span>' +
          '<span class="feed-when">' +
          '<button class="btn btn-secondary btn-sm" data-loc-id="' + UI.esc(doc.id) + '" data-loc-action="publish">Location is right — publish</button> ' +
          '<button class="btn btn-outline btn-sm" data-loc-id="' + UI.esc(doc.id) + '" data-loc-action="reject">Reject</button>' +
          '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-loc-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { resolveDupe(F, btn.getAttribute('data-loc-id'), btn.getAttribute('data-loc-action'), btn); });
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
          '<span class="feed-when"><button class="btn btn-secondary btn-sm" data-approve-id="' + UI.esc(doc.id) + '">Approve</button>' +
          suspendButton(d.contributorId) + '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-approve-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { approveSubmission(F, btn.getAttribute('data-approve-id'), btn); });
      });
      wireSuspendButtons(F, el);
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; }
  }

  // Lets an admin suspend a contributor directly from a flagged-submission or
  // dispute row — the queue item already has the exact contributorId at hand,
  // which is safer and faster than looking it up separately.
  function suspendButton(contributorId) {
    return contributorId ? ' <button class="btn btn-ghost btn-sm" data-suspend-contributor="' + UI.esc(contributorId) + '">Suspend contributor</button>' : '';
  }
  function wireSuspendButtons(F, el) {
    el.querySelectorAll('[data-suspend-contributor]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var userId = btn.getAttribute('data-suspend-contributor');
        var oldLabel = btn.textContent;
        btn.disabled = true; btn.textContent = 'Suspending…';
        suspendContributor(F, userId, 'Suspended from moderation queue').then(function () {
          btn.textContent = 'Suspended';
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = oldLabel;
          var err = document.createElement('div');
          err.className = 'field-error'; err.style.marginTop = '.3rem';
          err.textContent = 'Could not suspend: ' + e.message;
          btn.parentNode.appendChild(err);
        });
      });
    });
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
        var d = doc.data();
        rows.push('<div class="feed-item"><span>' + disputeLabel(d) + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-dispute-id="' + UI.esc(doc.id) + '">Resolve</button>' +
          suspendButton(d.contributorId) + '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-dispute-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { resolveDispute(F, btn.getAttribute('data-dispute-id'), btn); });
      });
      wireSuspendButtons(F, el);
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
