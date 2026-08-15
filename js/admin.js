/*
 * admin.js — Tabbed admin dashboard.
 *
 * Five tabs instead of one long scroll: Overview (health + what needs
 * attention), Activity (site analytics with a 24h/7d/30d window), Moderation
 * (flagged/disputes/dupes/location + suspensions), Claims (department
 * ownership), and Data tools (overrides, field locks). Everything still loads
 * in one pass — the tabs only show/hide sections, so switching is instant and
 * costs no extra Firestore reads. Access is gated to the admin role.
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
      host.innerHTML = card('Connect Firebase', '<p class="muted">The admin dashboard reads live moderation data from Firestore. Add your Firebase config to <span class="mono">js/firebase-init.js</span> to enable it. Overview metrics below use seed data as a preview.</p>') + deptStats();
      return;
    }
    if (!(A && A.isAdmin())) {
      host.innerHTML = '<div class="notice warn"><span class="notice-icon">🔒</span><div>Admin access only. <a href="/sign-in.html">Sign in</a> with an administrator account.</div></div>';
      return;
    }
    host.innerHTML = layout();
    wireTabs(host);
    wireActivityToggle();
    loadQueues();
  }

  // ---- Tabs ----------------------------------------------------------------
  var TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'moderation', label: 'Moderation' },
    { id: 'claims', label: 'Claims' },
    { id: 'data', label: 'Data tools' }
  ];

  function layout() {
    var bar = '<div class="admin-tabs" role="tablist" aria-label="Admin sections">' + TABS.map(function (t) {
      return '<button type="button" role="tab" id="tab-' + t.id + '" aria-controls="panel-' + t.id + '" aria-selected="false" tabindex="-1">' +
        t.label + '<span class="tab-badge" id="badge-' + t.id + '"></span></button>';
    }).join('') + '</div>';
    var panels = TABS.map(function (t) {
      return '<section role="tabpanel" id="panel-' + t.id + '" aria-labelledby="tab-' + t.id + '" hidden>' + PANELS[t.id]() + '</section>';
    }).join('');
    return bar + panels;
  }

  function wireTabs(host) {
    var tabs = host.querySelectorAll('.admin-tabs [role="tab"]');
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { selectTab(tab.id.replace(/^tab-/, '')); });
      // Standard tablist keyboard pattern: arrows move + activate.
      tab.addEventListener('keydown', function (e) {
        var dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        var next = TABS[(i + dir + TABS.length) % TABS.length].id;
        selectTab(next);
        document.getElementById('tab-' + next).focus();
      });
    });
    // "Review →" buttons and other cross-tab jumps anywhere in the dashboard.
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-goto-tab]');
      if (btn) selectTab(btn.getAttribute('data-goto-tab'));
    });
    var initial = (location.hash || '').replace(/^#/, '');
    selectTab(TABS.some(function (t) { return t.id === initial; }) ? initial : 'overview');
  }

  function selectTab(id) {
    TABS.forEach(function (t) {
      var tab = document.getElementById('tab-' + t.id);
      var panel = document.getElementById('panel-' + t.id);
      if (!tab || !panel) return;
      var on = t.id === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.setAttribute('tabindex', on ? '0' : '-1');
      panel.hidden = !on;
    });
    // Deep-linkable (#activity) without adding a history entry per click.
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ }
  }

  function setBadge(id, n) {
    var el = document.getElementById('badge-' + id);
    if (el) el.textContent = n > 0 ? String(n) : '';
  }

  // ---- Panels --------------------------------------------------------------
  var PANELS = {
    overview: function () {
      return '<h2>Overview</h2>' + deptStats() +
        '<div class="grid cols-2">' +
        '<div class="card"><h3>Needs attention</h3><div id="ov-attention"><p class="field-hint">Loading…</p></div></div>' +
        '<div class="card"><h3>Last 24 hours</h3><div id="ov-activity"><p class="field-hint">Loading…</p></div></div>' +
        '</div>';
    },
    activity: function () {
      return '<div class="admin-panel-head"><h2>Site activity</h2>' +
        '<div class="view-toggle" id="act-window" role="group" aria-label="Activity window">' +
        Object.keys(WINDOWS).map(function (k) {
          return '<button type="button" data-window="' + k + '"' + (k === _actWindow ? ' class="active"' : '') + '>' + WINDOWS[k].label + '</button>';
        }).join('') + '</div></div>' +
        '<p class="muted" style="margin-bottom:1rem">What visitors are doing — searches, page views, comparisons, submissions. Events are anonymous, session-capped, and kept for the dashboard\'s 30-day window.</p>' +
        '<div id="act-body"><p class="field-hint">Loading events…</p></div>';
    },
    moderation: function () {
      var q = function (id, title, hint) {
        return '<div class="card" style="margin-bottom:1rem"><h3>' + title + '</h3><p class="muted" style="margin-bottom:.75rem">' + hint + '</p><div id="' + id + '"><p class="field-hint">Loading…</p></div></div>';
      };
      return '<h2>Moderation</h2>' +
        '<p class="muted" style="margin-bottom:1rem">Routine salary submissions publish automatically and do <strong>not</strong> appear here — only automatically flagged items and reports do.</p>' +
        q('q-flagged', 'Flagged submissions', 'Auto-flagged by the moderation rules (large jumps, out-of-range, placeholder data).') +
        q('q-disputes', 'Disputes & abuse reports', 'Community-reported incorrect information and abuse reports.') +
        q('q-dupes', 'Possible duplicate departments', 'Suggested merges from contributors.') +
        q('q-location', 'Departments needing a location check', 'The ZIP could not be resolved to a Texas place, or it belongs to a different city than the one entered. Nothing here is on the map yet.') +
        suspendedCard();
    },
    claims: function () {
      return '<h2>Department claims</h2>' +
        '<p class="muted" style="margin-bottom:1rem">Requests to manage a department page via an official email domain, plus the claims currently in force.</p>' +
        '<div class="card" style="margin-bottom:1rem"><h3>Pending claims</h3><div id="q-claims"><p class="field-hint">Loading…</p></div></div>' +
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
        approvedDomainsCard();
    },
    data: function () {
      return '<h2>Data tools</h2>' +
        '<p class="muted" style="margin-bottom:1rem">Manual corrections that override or sit alongside community data. Everything here takes effect on the next scheduled refresh.</p>' +
        deptOverrideCard() + fieldLockCard();
    }
  };

  // ---- Overview ------------------------------------------------------------
  function deptStats() {
    var all = D.all();
    var withData = all.filter(function (d) { return d.summary.hasSalary; });
    var current = withData.filter(function (d) { return within(d.summary.lastUpdated, 12); });
    var conflicting = withData.filter(function (d) { return d.summary.hasConflict; });
    var stat = function (n, l) { return '<div class="card stat-card"><div class="stat-val">' + n + '</div><div class="stat-lab">' + l + '</div></div>'; };
    return '<div class="grid cols-4" style="margin-bottom:1rem">' +
      stat(all.length, 'Total departments') +
      stat(current.length, 'Departments with current data') +
      stat(all.length - withData.length, 'Departments needing updates') +
      stat(conflicting.length, 'Conflicting records') +
      '</div>';
  }

  // counts: null = that queue failed to load (shown as "?", never "all clear").
  function renderAttention(counts) {
    var el = document.getElementById('ov-attention'); if (!el) return;
    var rows = [
      { label: 'Flagged submissions', n: counts.flagged, tab: 'moderation' },
      { label: 'Disputes & abuse reports', n: counts.disputes, tab: 'moderation' },
      { label: 'Possible duplicate departments', n: counts.dupes, tab: 'moderation' },
      { label: 'Location checks', n: counts.location, tab: 'moderation' },
      { label: 'Pending department claims', n: counts.claims, tab: 'claims' }
    ];
    var pending = rows.filter(function (r) { return r.n == null || r.n > 0; });
    if (!pending.length) { el.innerHTML = '<p class="field-hint">All clear — nothing needs review. ✓</p>'; return; }
    el.innerHTML = pending.map(function (r) {
      var count = r.n == null ? '<span class="pill warn">unavailable</span>' : '<span class="pill">' + r.n + '</span>';
      return '<div class="feed-item"><span>' + r.label + ' ' + count + '</span>' +
        '<span class="feed-when"><button class="btn btn-outline btn-sm" data-goto-tab="' + r.tab + '">Review</button></span></div>';
    }).join('');
  }

  function renderOverviewActivity() {
    var el = document.getElementById('ov-activity'); if (!el) return;
    if (_eventsError) { el.innerHTML = '<p class="field-hint">Activity unavailable: ' + UI.esc(_eventsError) + '</p>'; return; }
    if (!_events) { el.innerHTML = '<p class="field-hint">Loading…</p>'; return; }
    var cutoff = Date.now() - WINDOWS['24h'].ms;
    var ev = _events.filter(function (e) { return e.ms >= cutoff; });
    var searches = ev.filter(function (e) { return e.type === 'search'; });
    var misses = searches.filter(function (e) { return e.value === 0; });
    var sessions = uniqueSessions(ev);
    var row = function (label, val) {
      return '<div class="feed-item"><span>' + label + '</span><span class="feed-when">' + val + '</span></div>';
    };
    el.innerHTML =
      row('Visitor sessions', sessions) +
      row('Searches', searches.length + (misses.length ? ' (' + misses.length + ' found nothing)' : '')) +
      row('Department page views', ev.filter(function (e) { return e.type === 'department_view'; }).length) +
      row('Submissions completed', ev.filter(function (e) { return e.type === 'submit_complete'; }).length) +
      '<div style="margin-top:.75rem"><button class="btn btn-outline btn-sm" data-goto-tab="activity">Open activity</button></div>';
  }

  // ---- Activity (js/analytics.js writes the events; admin-only read) -------
  var WINDOWS = {
    '24h': { label: '24 hours', ms: 24 * 3600 * 1000 },
    '7d': { label: '7 days', ms: 7 * 24 * 3600 * 1000 },
    '30d': { label: '30 days', ms: 30 * 24 * 3600 * 1000 }
  };
  var TYPE_LABELS = { department_view: 'Department views', search: 'Searches', compare_add: 'Added to comparison', submit_complete: 'Submissions completed',
    home_stat_click: 'Stat tile clicks', compare_example: 'Example comparisons', legend_toggle: 'Legend toggles', share: 'Department shares' };
  var KIND_LABELS = { department_view: 'Dept view', search: 'Search', compare_add: 'Compare', submit_complete: 'Submission',
    home_stat_click: 'Home', compare_example: 'Compare', legend_toggle: 'Map', share: 'Share' };
  var _events = null;       // normalized, newest first
  var _eventsError = null;
  var _actWindow = '24h';
  var _subs = null;         // recent submissions, newest first
  var _subsError = null;

  async function fetchEvents(F) {
    var cutoff = new Date(Date.now() - WINDOWS['30d'].ms);
    var qy = F.query(F.collection(window.FireDB.db, 'events'),
      F.where('timestamp', '>=', cutoff), F.orderBy('timestamp', 'desc'), F.limit(500));
    var snap = await F.getDocs(qy);
    var out = [];
    snap.forEach(function (doc) {
      var d = doc.data();
      var ms = d.timestamp && typeof d.timestamp.toMillis === 'function' ? d.timestamp.toMillis()
        : (d.date ? Date.parse(d.date) : 0);
      out.push({ type: d.type, ms: ms, page: d.page, query: d.query, value: d.value,
        slug: d.departmentSlug, label: d.label, session: d.sessionId });
    });
    return out;
  }

  function wireActivityToggle() {
    var host = document.getElementById('act-window'); if (!host) return;
    host.querySelectorAll('button[data-window]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _actWindow = btn.getAttribute('data-window');
        host.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        renderActivity();
      });
    });
  }

  function uniqueSessions(ev) {
    var seen = {};
    ev.forEach(function (e) { if (e.session) seen[e.session] = true; });
    return Object.keys(seen).length;
  }

  function agoShort(ms) {
    if (!ms) return '';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function hourLabel(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric' }); }
  function dayLabel(t) { return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); }

  // Column chart: hourly buckets for the 24h window, daily otherwise.
  function activityChart(ev) {
    var hourly = _actWindow === '24h';
    var sizeMs = hourly ? 3600000 : 86400000;
    var n = hourly ? 24 : (_actWindow === '7d' ? 7 : 30);
    var start;
    if (hourly) {
      start = Math.floor(Date.now() / sizeMs) * sizeMs - (n - 1) * sizeMs;
    } else {
      var d0 = new Date(); d0.setHours(0, 0, 0, 0);
      start = d0.getTime() - (n - 1) * sizeMs;
    }
    var buckets = [];
    for (var i = 0; i < n; i++) buckets.push(0);
    ev.forEach(function (e) {
      var idx = Math.floor((e.ms - start) / sizeMs);
      if (idx >= 0 && idx < n) buckets[idx]++;
    });
    var max = Math.max.apply(null, buckets.concat(1));
    var label = hourly ? hourLabel : dayLabel;
    var cols = buckets.map(function (c, i) {
      var t = start + i * sizeMs;
      return '<div class="act-col' + (c ? '' : ' is-zero') + '" style="height:' + Math.max(Math.round((c / max) * 100), 3) + '%" title="' +
        UI.esc(label(t)) + ' — ' + c + ' event' + (c === 1 ? '' : 's') + '"></div>';
    }).join('');
    return '<div class="act-chart" role="img" aria-label="Events over time">' + cols + '</div>' +
      '<div class="act-chart-axis"><span>' + UI.esc(label(start)) + '</span><span>' + (hourly ? 'now' : 'today') + '</span></div>';
  }

  function deptLink(slug) {
    return '<a href="/departments/' + UI.esc(slug) + '/" target="_blank" rel="noopener">' + UI.esc(slug) + '</a>';
  }

  function eventDesc(e) {
    var dept = e.slug ? deptLink(e.slug) : '';
    switch (e.type) {
      case 'search': {
        var res = e.value == null ? '' : (e.value === 0 ? ' · <span class="pill warn">no results</span>' : ' · ' + e.value + ' result' + (e.value === 1 ? '' : 's'));
        return '“' + UI.esc(e.query || '') + '”' + (e.page ? ' <span class="pill">' + UI.esc(e.page) + '</span>' : '') + res;
      }
      case 'department_view': return 'Viewed ' + (dept || 'a department');
      case 'compare_add': return 'Added ' + (dept || 'a department') + ' to comparison';
      case 'submit_complete': return 'Completed a submission' + (dept ? ' for ' + dept : '') + (e.label ? ' (' + UI.esc(e.label) + ')' : '');
      case 'share': return 'Shared ' + (dept || 'a department');
      case 'home_stat_click': return 'Clicked home stat' + (e.label ? ' “' + UI.esc(e.label) + '”' : '');
      case 'compare_example': return 'Opened example comparison' + (e.label ? ' “' + UI.esc(e.label) + '”' : '');
      case 'legend_toggle': return 'Map legend ' + (e.label ? UI.esc(e.label) : 'toggled');
      default: return UI.esc(e.type) + (e.label ? ' “' + UI.esc(e.label) + '”' : '');
    }
  }

  function top(obj, n) {
    return Object.keys(obj).map(function (k) { return { k: k, n: obj[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, n);
  }

  // ---- Recent submissions: what each one changed vs what the site showed ----
  // Mirrors scripts/export-overlay.js's toReport() field mapping so the diff
  // here matches what the public revision history will show after the next
  // refresh — including the quick-update `amount`/`salaryType` routing.
  function fetchRecentSubmissions(F) {
    var qy = F.query(F.collection(window.FireDB.db, 'submissions'),
      F.orderBy('submittedAt', 'desc'), F.limit(10));
    return F.getDocs(qy).then(function (snap) {
      var out = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var pv = d.proposedValues || {};
        var plan = d.plan || {};
        var ms = d.submittedAt && typeof d.submittedAt.toMillis === 'function' ? d.submittedAt.toMillis() : 0;
        var report = {
          contributorId: d.contributorId || null,
          submittedAt: ms ? new Date(ms).toISOString().slice(0, 10) : null,
          entry: pv.entry != null ? pv.entry : null,
          top: pv.top != null ? pv.top : null,
          midpoint: pv.midpoint != null ? pv.midpoint : null,
          recruit: pv.recruit != null ? pv.recruit : null,
          reportedEntry: pv.reportedEntry != null ? pv.reportedEntry : null,
          reportedTop: pv.reportedTop != null ? pv.reportedTop : null,
          reportedMidpoint: pv.reportedMidpoint != null ? pv.reportedMidpoint : null,
          supplemental: pv.supplemental || [],
          schedule: plan.schedule || pv.schedule || null,
          hoursAnnual: plan.hoursAnnual != null ? plan.hoursAnnual : (pv.hoursAnnual != null ? pv.hoursAnnual : null),
          effectiveDate: plan.effectiveDate || pv.effectiveDate || null
        };
        // Quick updates carry one figure as amount + salaryType (see
        // metricFromType in the export): top types → top, hourly → skip.
        if (pv.amount != null) {
          var t = String(pv.salaryType || '');
          if (report.top == null && (t === 'top-ff' || t === 'top-ff-medic')) report.top = pv.amount;
          else if (report.entry == null && t !== 'hourly-base') report.entry = pv.amount;
        }
        out.push({
          id: doc.id, slug: d.departmentSlug || null, name: d.name || null, city: d.city || null,
          status: d.status, mode: d.mode, submissionType: d.submissionType,
          contributorType: d.contributorType, contributorId: d.contributorId || null,
          ms: ms, sourceUrl: d.sourceUrl || null, sourceFile: d.sourceFile || null,
          report: report
        });
      });
      return out;
    });
  }

  // The report this submission should be diffed against: the newest earlier
  // non-confirmation report on the department (seed import included), skipping
  // the overlay's copy of this same submission (same contributor, same day).
  function prevReportFor(sub) {
    var dept = sub.slug ? D.get(sub.slug) : null;
    var reports = (dept && dept.salary && dept.salary.reports) || [];
    var best = null;
    reports.forEach(function (r) {
      if (r.confirmation) return;
      if (r.contributorId === sub.contributorId && r.submittedAt === sub.report.submittedAt) return;
      if (sub.report.submittedAt && r.submittedAt && String(r.submittedAt) > sub.report.submittedAt) return;
      if (!best || String(r.submittedAt || '') > String(best.submittedAt || '')) best = r;
    });
    return best;
  }

  // ---- Contributor identity (admin-only) ----
  // Submissions store only the Firebase uid; users/{uid} (admin-readable per
  // firestore.rules) has displayName/trust/counts but NO email — Firebase Auth
  // holds emails and is unreachable client-side without the Admin SDK. To see
  // an email, search the uid under Firebase console → Authentication.
  var _profileCache = {};
  async function resolveContributors(F, ids) {
    var pending = ids.filter(function (id, i) {
      return id && ids.indexOf(id) === i && !(id in _profileCache) &&
        id.indexOf('admin:') !== 0 && !/-import$/.test(id);
    });
    await Promise.all(pending.map(async function (id) {
      try {
        var snap = await F.getDoc(F.doc(window.FireDB.db, 'users', id));
        _profileCache[id] = snap.exists() ? snap.data() : null;
      } catch (e) { _profileCache[id] = null; }
    }));
  }

  function contributorLabel(id) {
    if (!id) return 'unknown contributor';
    if (id.indexOf('admin:') === 0) return UI.esc(id.slice(6)) + ' (admin)';
    if (/-import$/.test(id)) return 'official import';
    var p = _profileCache[id];
    var uidShort = '<span class="mono" title="' + UI.esc(id) + '">' + UI.esc(id.slice(0, 8)) + '…</span>';
    if (!p) return uidShort;
    var bits = [];
    if (p.suspended) bits.push('suspended');
    if (p.trustStatus === 'trusted') bits.push('trusted');
    if (p.submissionCount != null) bits.push(p.submissionCount + ' submission' + (p.submissionCount === 1 ? '' : 's'));
    return UI.esc(p.displayName || 'Contributor') + (bits.length ? ' (' + bits.join(' · ') + ')' : '') + ' · ' + uidShort;
  }

  // Fills every "by …" placeholder rendered before profiles resolved.
  function applyContributorLabels() {
    document.querySelectorAll('[data-cid]').forEach(function (el) {
      el.innerHTML = 'by ' + contributorLabel(el.getAttribute('data-cid'));
    });
  }
  function contributorLine(id) {
    return id ? '<br><small class="muted" data-cid="' + UI.esc(id) + '">by <span class="mono">' + UI.esc(id.slice(0, 8)) + '…</span></small>' : '';
  }

  var MODE_LABELS = { single: 'quick update', range: 'range form', plan: 'step-plan form' };
  function submissionsBody() {
    if (_subsError) return '<p class="field-hint">Submissions unavailable: ' + UI.esc(_subsError) + '</p>';
    if (!_subs) return '<p class="field-hint">Loading…</p>';
    if (!_subs.length) return '<p class="field-hint">No community submissions yet.</p>';
    return _subs.map(function (s) {
      var prev = prevReportFor(s);
      var changes = Lib.describeRevisionChanges(s.report, prev);
      var chips = changes.map(function (c) {
        var fmt = function (v) { return c.kind === 'money' ? UI.money(v) : UI.esc(String(v)); };
        // "new" marks a figure the site didn't show before — except a removal
        // (to === 'Removed'), where the pair would read as a contradiction.
        return '<span class="diff-chip"><small>' + UI.esc(c.label) + '</small>' +
          (c.from == null
            ? fmt(c.to) + (c.to === 'Removed' ? '' : ' <span class="pill">new</span>')
            : '<span class="diff-old">' + fmt(c.from) + '</span> → ' + fmt(c.to)) +
          '</span>';
      }).join('') || '<span class="field-hint">No figure changes — confirmation or note only.</span>';
      var who = s.contributorType === 'department' ? 'Department representative' : 'Community contributor';
      var dept = s.slug ? deptLink(s.slug)
        : UI.esc([s.name, s.city].filter(Boolean).join(', ') || 'unknown department');
      var src = Lib.safeUrl(s.sourceUrl || s.sourceFile);
      var flagged = s.status === 'flagged' ? ' <span class="pill warn">flagged — in Moderation</span>' : '';
      var baseline = prev
        ? (/-import$/.test(String(prev.contributorId || '')) ? 'vs official import' : 'vs previous report')
        : 'first report';
      return '<div class="sub-item">' +
        '<div class="sub-head"><strong>' + dept + '</strong>' +
        ' <span class="pill">' + UI.esc(who) + '</span>' +
        ' <span class="pill">' + UI.esc(MODE_LABELS[s.mode] || s.mode || 'update') + '</span>' +
        ' <span class="pill">' + baseline + '</span>' + flagged +
        '<span class="feed-when">' + (src ? '<a href="' + UI.esc(src) + '" target="_blank" rel="nofollow noopener">Source ↗</a> · ' : '') + agoShort(s.ms) + '</span></div>' +
        (s.contributorId ? '<div class="sub-who" data-cid="' + UI.esc(s.contributorId) + '">by ' + contributorLabel(s.contributorId) + '</div>' : '') +
        '<div class="sub-diffs">' + chips + '</div>' +
        '</div>';
    }).join('');
  }

  function renderActivity() {
    var host = document.getElementById('act-body'); if (!host) return;
    if (_eventsError) { host.innerHTML = '<p class="field-hint">Analytics unavailable: ' + UI.esc(_eventsError) + '</p>'; return; }
    if (!_events) { host.innerHTML = '<p class="field-hint">Loading events…</p>'; return; }
    var cutoff = Date.now() - WINDOWS[_actWindow].ms;
    var ev = _events.filter(function (e) { return e.ms >= cutoff; })
      .sort(function (a, b) { return b.ms - a.ms; });

    var searches = ev.filter(function (e) { return e.type === 'search'; });
    var views = ev.filter(function (e) { return e.type === 'department_view'; });
    var byType = {}, byDept = {}, byQuery = {}, byMiss = {};
    ev.forEach(function (e) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.type === 'department_view' && e.slug) byDept[e.slug] = (byDept[e.slug] || 0) + 1;
      if (e.type === 'search' && e.query) {
        var q = String(e.query).toLowerCase().trim();
        byQuery[q] = (byQuery[q] || 0) + 1;
        // value === 0 is a search that found NOTHING — someone wanted a
        // department the database doesn't have. Ranked below as the expansion
        // to-do list. (Undefined value = count unknown, not a miss.)
        if (e.value === 0) byMiss[q] = (byMiss[q] || 0) + 1;
      }
    });

    var stat = function (n, l) { return '<div class="card stat-card"><div class="stat-val">' + n + '</div><div class="stat-lab">' + l + '</div></div>'; };
    var tiles = '<div class="grid cols-4" style="margin-bottom:1rem">' +
      stat(ev.length, 'Events') +
      stat(searches.length, 'Searches') +
      stat(views.length, 'Department views') +
      stat(uniqueSessions(ev), 'Unique sessions') +
      '</div>';

    var chartCard = '<div class="card" style="margin-bottom:1rem"><h3>' +
      (_actWindow === '24h' ? 'Events by hour' : 'Events by day') + '</h3>' + activityChart(ev) + '</div>';

    var subsCard = '<div class="card" style="margin-bottom:1rem"><h3>Recent submissions</h3>' +
      '<p class="field-hint" style="margin-top:0">The latest 10 regardless of the window above — each shows what it changed against what the site displayed before it.</p>' +
      submissionsBody() + '</div>';

    var searchRows = searches.slice(0, 30).map(function (e) {
      return '<div class="feed-item"><span>' + eventDesc(e) + '</span><span class="feed-when">' + agoShort(e.ms) + '</span></div>';
    }).join('') || '<p class="field-hint">No searches in this window.</p>';
    var searchNote = searches.length > 30 ? '<p class="field-hint" style="margin-top:0">Latest 30 of ' + searches.length + '.</p>' : '';

    var feedRows = ev.slice(0, 30).map(function (e) {
      return '<div class="feed-item"><span class="feed-kind">' + (KIND_LABELS[e.type] || UI.esc(e.type)) + '</span><span>' + eventDesc(e) + '</span><span class="feed-when">' + agoShort(e.ms) + '</span></div>';
    }).join('') || '<p class="field-hint">No events in this window.</p>';

    var queryRows = top(byQuery, 8).map(function (row) {
      return '<div class="feed-item"><span>' + UI.esc(row.k) + '</span><span class="feed-when">' + row.n + '×</span></div>';
    }).join('') || '<p class="field-hint">No searches yet.</p>';

    var missRows = top(byMiss, 10).map(function (row) {
      return '<div class="feed-item"><span>' + UI.esc(row.k) + '</span><span class="feed-when">' + row.n + '×</span></div>';
    }).join('') || '<p class="field-hint">Every search found something.</p>';

    var deptRows = top(byDept, 8).map(function (row) {
      return '<div class="feed-item"><span>' + deptLink(row.k) + '</span><span class="feed-when">' + row.n + ' view' + (row.n === 1 ? '' : 's') + '</span></div>';
    }).join('') || '<p class="field-hint">No department views yet.</p>';

    var typeRows = top(byType, 20).map(function (row) {
      return '<div class="feed-item"><span>' + (TYPE_LABELS[row.k] || UI.esc(row.k)) + '</span><span class="feed-when">' + row.n + '</span></div>';
    }).join('') || '<p class="field-hint">No events yet.</p>';

    host.innerHTML = tiles + chartCard + subsCard +
      '<div class="grid cols-2" style="margin-bottom:1rem">' +
      '<div class="card"><h3>Recent searches</h3>' + searchNote + searchRows + '</div>' +
      '<div class="card"><h3>Recent activity</h3>' + feedRows + '</div>' +
      '</div>' +
      '<div class="grid cols-2" style="margin-bottom:1rem">' +
      '<div class="card"><h3>Top searches</h3>' + queryRows + '</div>' +
      '<div class="card"><h3>Searched but not found</h3><p class="field-hint" style="margin-top:0">Departments people wanted and couldn\'t find — the expansion list.</p>' + missRows + '</div>' +
      '</div>' +
      '<div class="grid cols-2">' +
      '<div class="card"><h3>Most-viewed departments</h3>' + deptRows + '</div>' +
      '<div class="card"><h3>Events by type</h3>' + typeRows + '</div>' +
      '</div>';
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
        '<div class="field"><label for="fl-note">Note (public — locks show it beside the figure, corrections on their history card)</label><input id="fl-note" type="text" placeholder="e.g. Verified against the FY26 pay ordinance"></div>' +
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
        return '<div class="feed-item"><span>' + deptLink(d.departmentSlug) + ' — ' + (FIELD_LABELS[d.field] || d.field) + ': $' + UI.esc(d.value) + (d.note ? ' (' + UI.esc(d.note) + ')' : '') + '</span>' +
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
    var counts = {};
    counts.flagged = await fillFlaggedQueue(F);
    counts.disputes = await fillDisputesQueue(F);
    counts.claims = await fillClaimsQueue(F);
    await fillActiveClaimsQueue(F);
    wireAddClaimForm(F);
    counts.dupes = await fillDupesQueue(F);
    counts.location = await fillLocationQueue(F);
    await fillSuspendedQueue(F);
    wireSuspendForm(F);
    wireDeptOverrideForm(F);
    await fillFieldLocksQueue(F);
    wireFieldLockForm(F);
    await fillApprovedDomainsQueue(F);
    wireApprovedDomainsForm(F);
    renderAttention(counts);
    var sum = function (a, b) { return (a || 0) + (b || 0); };
    setBadge('moderation', [counts.flagged, counts.disputes, counts.dupes, counts.location].reduce(sum, 0));
    setBadge('claims', counts.claims || 0);
    try {
      _events = await fetchEvents(F); _eventsError = null;
    } catch (e) {
      _events = null; _eventsError = e.message;
    }
    try {
      _subs = await fetchRecentSubmissions(F); _subsError = null;
    } catch (e) {
      _subs = null; _subsError = e.message;
    }
    // Resolve who: every contributor rendered in the queues above plus the
    // recent submissions, in one batch, then patch the placeholders.
    var cids = (_subs || []).map(function (s) { return s.contributorId; });
    document.querySelectorAll('[data-cid]').forEach(function (el) { cids.push(el.getAttribute('data-cid')); });
    await resolveContributors(F, cids);
    applyContributorLabels();
    renderActivity();
    renderOverviewActivity();
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
    var el = document.getElementById('q-claims'); if (!el) return null;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_claims'), F.where('status', '==', 'pending'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return 0; }
      var approvedDomains = await approvedDomainSet(F);
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var dept = d.departmentSlug ? deptLink(d.departmentSlug) : 'unknown department';
        // Older claims (written before email was captured) only have
        // emailDomain — fall back to that rather than showing nothing.
        var who = d.email || (d.emailDomain ? ('someone @' + d.emailDomain) : 'unknown email');
        var recognized = d.emailDomain && approvedDomains.has(d.emailDomain) ? ' <span class="pill">recognized domain</span>' : '';
        rows.push('<div class="feed-item"><span>' + dept + ' — claimed by ' + UI.esc(who) + recognized + '</span>' +
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
      return snap.size;
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; return null; }
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
        var dept = slug
          ? '<a href="/departments/' + UI.esc(slug) + '/" target="_blank" rel="noopener">' + UI.esc(d.departmentName || slug) + '</a>'
          : 'unknown department';
        var who = d.email || (d.emailDomain ? ('someone @' + d.emailDomain) : 'unknown email');
        rows.push('<div class="feed-item"><span>' + dept + ' — ' + UI.esc(who) + '</span>' +
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
    var el = document.getElementById('q-dupes'); if (!el) return null;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_requests'), F.where('status', '==', 'possible_duplicate'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return 0; }
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
      return snap.size;
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; return null; }
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
    var el = document.getElementById('q-location'); if (!el) return null;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'department_requests'), F.where('status', '==', 'location_review'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return 0; }
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
      return snap.size;
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; return null; }
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
    var el = document.getElementById('q-flagged'); if (!el) return null;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'submissions'), F.where('status', '==', 'flagged'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return 0; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var dept = d.departmentSlug ? deptLink(d.departmentSlug) : 'unknown department';
        var reasons = (d.automatedFlags || []).join('; ') || 'flagged';
        rows.push('<div class="feed-item"><span>' + dept + ' — ' + UI.esc(reasons) + contributorLine(d.contributorId) + '</span>' +
          '<span class="feed-when"><button class="btn btn-secondary btn-sm" data-approve-id="' + UI.esc(doc.id) + '">Approve</button>' +
          suspendButton(d.contributorId) + '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-approve-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { approveSubmission(F, btn.getAttribute('data-approve-id'), btn); });
      });
      wireSuspendButtons(F, el);
      return snap.size;
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; return null; }
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

  // Disputes gets its own queue renderer (not a generic one) because resolving
  // a dispute sets its status away from 'open', which is exactly the filter
  // scripts/export-overlay.js's countStepPlanDisputes/countValueDisputes use,
  // so a resolved dispute stops counting toward the revert threshold on the
  // next scheduled refresh.
  function disputeLabel(d) {
    var dept = d.departmentSlug ? deptLink(d.departmentSlug) : 'unknown department';
    var what = d.field === 'stepPlan'
      ? 'pay-step plan flagged'
      : (d.field || 'entry') + ' disputed (' + (d.disputedValue != null ? '$' + d.disputedValue : '?') + (d.proposedValue != null ? ' → $' + d.proposedValue : '') + ')';
    return dept + ' — ' + what + (d.reason ? ': ' + UI.esc(String(d.reason).slice(0, 80)) : '');
  }

  async function fillDisputesQueue(F) {
    var el = document.getElementById('q-disputes'); if (!el) return null;
    try {
      var qy = F.query(F.collection(window.FireDB.db, 'disputes'), F.where('status', '==', 'open'), F.limit(25));
      var snap = await F.getDocs(qy);
      if (snap.empty) { el.innerHTML = '<p class="field-hint">Nothing in this queue. ✓</p>'; return 0; }
      var rows = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        rows.push('<div class="feed-item"><span>' + disputeLabel(d) + contributorLine(d.contributorId) + '</span>' +
          '<span class="feed-when"><button class="btn btn-outline btn-sm" data-dispute-id="' + UI.esc(doc.id) + '">Resolve</button>' +
          suspendButton(d.contributorId) + '</span></div>');
      });
      el.innerHTML = rows.join('');
      el.querySelectorAll('[data-dispute-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { resolveDispute(F, btn.getAttribute('data-dispute-id'), btn); });
      });
      wireSuspendButtons(F, el);
      return snap.size;
    } catch (e) { el.innerHTML = '<p class="field-hint">Queue unavailable: ' + UI.esc(e.message) + '</p>'; return null; }
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

  function within(ms, months) { return ms && (Date.now() - ms) <= months * 30.437 * 24 * 3600 * 1000; }
  function card(title, body) { return '<div class="card" style="margin-bottom:1.5rem"><h3>' + title + '</h3>' + body + '</div>'; }
})();
