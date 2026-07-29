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
  });

  function renderAll() {
    renderCareer();
    renderHistory();
    renderConfidence();
    renderRevisions();
    wireActions();
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
  function renderConfidence() {
    var host = document.getElementById('confidence-panel');
    if (!host) return;
    var s = summary;
    var clusters = s.clusters || [];
    var newest = s.newestSubmission ? new Date(s.newestSubmission).toISOString().slice(0, 10) : '—';
    var oldest = s.oldestCurrent ? new Date(s.oldestCurrent).toISOString().slice(0, 10) : '—';
    host.innerHTML =
      '<h2>Community confidence</h2>' +
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
      form.innerHTML = '<div class="card card-tight" style="margin-top:.6rem">' +
        '<div class="field"><label for="dv">Corrected entry firefighter pay</label><input id="dv" type="number" inputmode="numeric" placeholder="$"></div>' +
        '<div class="field"><label for="dr">What is wrong?</label><textarea id="dr" placeholder="Explain what should change and how you know."></textarea></div>' +
        '<button class="btn btn-primary btn-sm" id="dsub">Submit dispute</button></div>';
      document.getElementById('dsub').addEventListener('click', function () {
        var val = document.getElementById('dv').value, reason = document.getElementById('dr').value;
        writeDispute(val, reason).then(function () { form.innerHTML = '<p class="field-hint">Thanks — your dispute was submitted and is now visible with the record.</p>'; })
          .catch(function (e) { statusEl.textContent = 'Could not submit dispute: ' + e.message; });
      });
    });
  }

  async function writeConfirmation() {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    await F.addDoc(F.collection(db.db, 'confirmations'), {
      departmentSlug: dept.slug, contributorId: A.user.uid, confirmationType: 'looks_correct', createdAt: F.serverTimestamp()
    });
  }
  async function writeDispute(value, reason) {
    var db = window.FireDB;
    if (!db || !db.ready) throw new Error('Firebase not configured');
    var F = db.sdk.firestore;
    await F.addDoc(F.collection(db.db, 'disputes'), {
      departmentSlug: dept.slug, field: 'entry', disputedValue: summary.entry,
      proposedValue: Lib.parseMoney(value), contributorId: A.user.uid, reason: String(reason || '').slice(0, 1000),
      status: 'open', createdAt: F.serverTimestamp()
    });
  }
})();
