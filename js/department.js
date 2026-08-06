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
    // esc() alone would let a javascript: URL through untouched — it contains
    // no markup characters. Lib.safeUrl is what actually gates the href.
    var href = Lib.safeUrl(summary && summary.sourceUrl);
    return href
      ? '<a href="' + UI.esc(href) + '" target="_blank" rel="nofollow noopener">' + linkLabel + '</a>'
      : (fallbackLabel || '');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var node = document.getElementById('dept-data');
    if (!node) return;
    try { dept = JSON.parse(node.textContent); } catch (e) { console.error('bad dept-data', e); return; }
    summary = D.deriveSummary(dept);
    renderAll();
    if (window.FireAnalytics) window.FireAnalytics.trackDepartmentView(dept.slug);
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
    host.innerHTML = '<div class="dept-claim-panel">' +
      '<div><h3>Represent this department?</h3>' +
      '<p>If you manage this page officially, request "Department maintained" status. An admin reviews every request.</p>' +
      '<div id="claim-status" class="field-hint" style="margin-top:.5rem"></div></div>' +
      '<button class="btn btn-outline" id="act-claim">Claim this department</button>' +
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
        host.innerHTML = '<div class="dept-claimed-notice"><span aria-hidden="true">◆</span><div>' +
          '<strong>You are the verified contact for ' + UI.esc(dept.name) + '.</strong> ' +
          '<p>A pay figure you submit becomes the one shown here right away, without waiting to out-vote other community reports.</p></div></div>';
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
    var host = document.getElementById('earnings');
    if (!host || !summary.hasSalary || !summary.steps) { if (host) { host.innerHTML = ''; host.className = ''; } return; }
    host.className = 'dept-section';
    // A single reported rate has no real progression to project — showing
    // exact 5/10/20-year totals off one flat number reads as far more
    // precise than the underlying data actually supports.
    if (summary.singleRatePlan) {
      host.innerHTML =
        '<div class="dept-section-heading compact"><div><span class="section-kicker">Projection</span><h2>Career earnings</h2></div></div>' +
        '<p class="dept-section-intro">Not shown yet — only a single pay rate has been reported for this department, with no step progression to project. ' +
        '<a href="/submit.html?dept=' + UI.esc(dept.slug) + '&mode=step">Add the full pay-step plan →</a></p>';
      return;
    }
    var baseSteps = Lib.stepsForField(summary.steps, 'baseAnnualSalary');
    var repSteps = Lib.stepsForField(summary.steps, 'reportedAnnualCompensation');
    var years = [5, 10, 20];
    function totals(steps) { return years.map(function (y) { return Lib.projectEarnings(steps, y); }); }
    var baseTotals = totals(baseSteps);
    var anyCF = baseTotals.some(function (r) { return r.assumedCarryForward; }) ||
      (repSteps.length && totals(repSteps).some(function (r) { return r.assumedCarryForward; }));
    function barsFor(label, rows) {
      var max = Math.max.apply(null, rows.map(function (r) { return r.total || 0; })) || 1;
      return '<div class="earnings-card">' + years.map(function (y, i) {
        var r = rows[i];
        var pct = r.total == null ? 0 : Math.max(4, Math.round((r.total / max) * 100));
        return '<div class="earnings-row"><span class="years">' + y + ' <small>years</small></span>' +
          '<div class="earnings-bar-track"><span style="width:' + pct + '%"></span></div>' +
          '<strong>' + (r.total == null ? '—' : UI.money(r.total)) + '</strong></div>';
      }).join('') + '</div>';
    }
    host.innerHTML =
      '<div class="dept-section-heading compact"><div><span class="section-kicker">Projection</span><h2>Career earnings</h2></div></div>' +
      '<p class="dept-section-intro">Illustrative earnings at the current reported pay plan — not a forecast. <strong>Base salary</strong> and <strong>reported total compensation</strong> are kept separate — do not add them together.</p>' +
      barsFor('Base salary', baseTotals) +
      (repSteps.length ? '<p class="field-hint" style="margin:1rem 0 .5rem">Reported total compensation</p>' + barsFor('Reported total compensation', totals(repSteps)) : '') +
      '<p class="dept-fine-print">Assumes the step in effect at the start of each service year.' +
        (anyCF ? ' Where the plan\'s final step is bounded, it assumes the final submitted step continues for later years.' : '') +
        ' Excludes raises, promotions, actual overtime worked, and benefits.</p>';
  }

  // ---- Salary history (SVG chart + table) ----
  // Only the trend chart — the tabular breakdown of every submission already
  // lives in renderRevisions() below (same section now), which additionally
  // shows contributor type and current/superseded status, so a separate plain
  // table here would just repeat the same dates and figures.
  function renderHistory() {
    var host = document.getElementById('salary-history');
    if (!host) return;
    var reports = ((dept.salary && dept.salary.reports) || []).slice().filter(function (r) { return r.entry != null && r.submittedAt; });
    reports.sort(function (a, b) { return Date.parse(a.submittedAt) - Date.parse(b.submittedAt); });
    var pts = reports.map(function (r) { return { t: Date.parse(r.submittedAt), entry: r.entry, top: r.top, when: r.submittedAt }; });
    host.innerHTML = pts.length >= 2 ? chartSVG(pts) : '';
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

  // ---- Community confidence panel + actions ----
  var DISPUTE_FIELDS = [['entry', 'Entry pay'], ['midpoint', 'Midpoint pay'], ['top', 'Top pay']];

  function renderConfidence() {
    var host = document.getElementById('confidence-panel');
    if (!host) return;
    var s = summary;
    var clusters = s.clusters || [];
    var newest = s.newestSubmission ? new Date(s.newestSubmission).toISOString().slice(0, 10) : '—';
    var oldest = s.oldestCurrent ? new Date(s.oldestCurrent).toISOString().slice(0, 10) : '—';
    var contributors = s.contributors || 0;
    // Ring fill is a rough "how close to strong consensus" gauge, reusing the
    // same 3-contributor threshold export-overlay.js uses elsewhere to treat a
    // value as strongly agreed-upon — not a precise statistic, just a glance cue.
    var ringPct = Math.max(0, Math.min(100, Math.round((contributors / 3) * 100)));
    // A disputed figure stays showing (never silently reverted by a single flag)
    // until enough distinct community members dispute the SAME value — see
    // scripts/export-overlay.js's applyValueDisputes. Below the threshold, it's
    // just called out here so visitors know it's contested.
    var disputed = DISPUTE_FIELDS.filter(function (f) { return (s[f[0] + 'DisputeCount'] || 0) > 0; });
    var disputeAlert = disputed.length
      ? sideAlert('Disputed figures', disputed.map(function (f) {
          return f[1] + ' disputed by ' + s[f[0] + 'DisputeCount'] + ' community member' + (s[f[0] + 'DisputeCount'] === 1 ? '' : 's');
        }).join('; ') + '. Reverts to the prior value if enough others agree.')
      : '';
    var freshnessAlert = (s.freshness && (s.freshness.key === 'update_recommended' || s.freshness.key === 'possibly_outdated'))
      ? sideAlert(s.freshness.label, s.freshness.description)
      : '';
    var LOCK_LABELS = { entry: 'Entry pay', top: 'Top pay', midpoint: 'Midpoint pay' };
    var lockedFields = ['entry', 'top', 'midpoint'].filter(function (f) { return s[f + 'Locked']; });
    var lockAlert = lockedFields.length
      ? sideAlert('Verified by admin', lockedFields.map(function (f) {
          return LOCK_LABELS[f] + (s[f + 'OverrideNote'] ? ': ' + s[f + 'OverrideNote'] : '');
        }).join('; ') + '. This figure stays fixed until an admin changes it, regardless of new submissions.')
      : '';
    host.innerHTML =
      '<div class="confidence-card">' +
        '<div class="confidence-header">' +
          '<div><span>Data confidence</span><strong>' + UI.esc(s.confidence.label) + '</strong></div>' +
          '<div class="confidence-ring" style="--ring-pct:' + ringPct + '"><span>' + contributors + '</span><small>REPORTS</small></div>' +
        '</div>' +
        '<div class="confidence-list">' +
          confRow('Matching submissions', clusters.length ? clusters[0].submissions.length : 0) +
          confRow('Contributors confirming', contributors) +
          (s.trustedContributors ? confRow('Trusted contributors', '<span class="positive">' + s.trustedContributors + '</span>') : '') +
          confRow('Newest submission', newest) +
          confRow('Oldest current matching', oldest) +
          confRow('Conflicting values', s.hasConflict ? '<a href="#history">Yes, see history</a>' : 'No') +
          confRow('Source supplied', s.sourceUrl ? payPlanLink('View pay plan ↗') : 'No') +
          confRow('Department maintained', s.departmentMaintained ? '<span class="positive">Yes</span>' : 'No') +
        '</div>' +
        disputeAlert + freshnessAlert + lockAlert +
        '<div class="gate" id="dept-gate"><span aria-hidden="true">🔒</span><div>Sign in with a verified email to confirm, update, or dispute this information. <a href="/sign-in.html">Sign in →</a></div></div>' +
        '<div class="confidence-actions-side">' +
          '<a class="btn btn-primary full" href="/submit.html?dept=' + UI.esc(dept.slug) + '&mode=update">Submit an update</a>' +
          '<button class="btn btn-outline" id="act-confirm">This looks correct</button>' +
          '<button class="btn btn-outline" id="act-dispute">Report incorrect information</button>' +
        '</div>' +
        '<div id="act-status" class="field-hint" style="margin:0 var(--sp-5) var(--sp-4)"></div>' +
        '<div id="dispute-form"></div>' +
        '<p class="confidence-card-disclaimer">' + UI.esc(s.confidence.description) + ' Community-submitted, not verified payroll records.</p>' +
      '</div>';
  }
  function confRow(k, v) { return '<div><span>' + k + '</span><strong>' + v + '</strong></div>'; }
  function sideAlert(title, body) {
    return '<div class="confidence-side-alert"><span class="alert-dot" aria-hidden="true"></span><div><strong>' + UI.esc(title) + '</strong><p>' + UI.esc(body) + '</p></div></div>';
  }
  function fieldValue(field) { return field === 'top' ? summary.topBase : field === 'midpoint' ? summary.midpoint : summary.entry; }

  // ---- Revision history (public; no emails) ----
  var REV_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function revDate(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return { m: UI.esc(iso || '—'), y: '' };
    var d = new Date(t);
    return { m: REV_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(), y: String(d.getUTCFullYear()) };
  }
  // Names the revision by what it did. "Reported pay plan" on every card told a
  // contributor nothing about whether their own submission had landed, which is
  // the main reason anyone opens this section.
  function revisionHeadline(changes, isFirst) {
    if (!changes.length) return isFirst ? 'First reported figures' : 'Confirmed existing figures';
    var added = changes.filter(function (c) { return c.from == null; }).length;
    var edited = changes.length - added;
    if (isFirst) return 'First reported figures';
    if (added && !edited) return added === 1 ? 'Added ' + changes[0].label.toLowerCase() : 'Added ' + added + ' figures';
    if (edited && !added) return edited === 1 ? 'Updated ' + changes[0].label.toLowerCase() : 'Updated ' + edited + ' figures';
    return 'Updated ' + edited + ' and added ' + added;
  }

  // One chip per change: an added value shows just the new figure; a changed one
  // shows old → new so the movement is readable at a glance.
  function changeChips(changes) {
    if (!changes.length) return '<span class="muted" style="font-size:var(--fs-sm)">No figures changed</span>';
    return changes.map(function (c) {
      var to = c.kind === 'count' ? c.to : UI.money(c.to);
      var body = (c.from == null)
        ? to
        : '<span class="rv-old">' + (c.kind === 'count' ? c.from : UI.money(c.from)) + '</span> → ' + to;
      return '<span><small>' + UI.esc(c.label) + '</small>' + body + '</span>';
    }).join('');
  }

  // A link to the evidence THIS revision was submitted with. An uploaded file
  // and a pasted URL are labelled differently so a reader knows whether they're
  // opening a document the contributor attached or a page they cited.
  function revisionSourceLink(r) {
    var href = Lib.safeUrl(r.sourceUrl || r.sourceFile);
    if (!href) return '';
    var label = r.sourceFile && !r.sourceUrl ? 'Attached document ↗' : 'Source ↗';
    return '<a href="' + UI.esc(href) + '" target="_blank" rel="nofollow noopener">' + label + '</a>';
  }

  function renderRevisions() {
    var host = document.getElementById('revision-history');
    if (!host) return;
    var reports = ((dept.salary && dept.salary.reports) || []).slice();
    if (!reports.length) { host.innerHTML = ''; return; }
    reports.sort(function (a, b) { return Date.parse(b.submittedAt) - Date.parse(a.submittedAt); });
    // Only the CURRENT full pay-step plan is retained (see export-overlay.js's
    // extractStepPlans — no per-revision step history yet), so a link to it only
    // makes sense on the current entry, not on superseded ones below.
    var hasStepPlan = !!(summary.steps && summary.steps.length >= 3);
    host.innerHTML =
      '<p class="dept-section-intro" style="margin-top:0">Every submission is preserved, with what each one changed. Contributor identities are shown by type only.</p>' +
      '<div class="history-timeline">' +
      reports.map(function (r, i) {
        var isCurrent = i === 0;
        var type = r.adminCorrection ? 'Admin correction' : r.departmentMaintained ? 'Department representative' : 'Community contributor';
        var when = revDate(r.submittedAt);
        // Diffed against the NEXT entry, which is the one before it in time
        // (the list is newest-first). The oldest revision has no predecessor,
        // so everything it carries reads as added.
        var changes = Lib.describeRevisionChanges(r, reports[i + 1] || null);
        return '<div class="history-card">' +
          '<div class="history-date"><strong>' + when.m + '</strong><span>' + when.y + '</span></div>' +
          '<div class="history-line"><i aria-hidden="true"></i></div>' +
          '<div class="history-details' + (isCurrent ? '' : ' superseded') + '">' +
            '<div class="history-title"><div><strong>' + revisionHeadline(changes, i === reports.length - 1) + '</strong><span>' + type + '</span></div>' +
              '<span class="' + (isCurrent ? 'history-current-pill' : 'history-superseded-pill') + '">' + (isCurrent ? 'Current' : 'Superseded') + '</span>' +
            '</div>' +
            '<div class="history-values">' +
              changeChips(changes) +
              // This revision's OWN source, not the step plan's — payPlanLink
              // reads summary.sourceUrl, so every card used to link the same
              // document regardless of which submission it came from.
              revisionSourceLink(r) +
              (isCurrent && hasStepPlan ? '<a href="#step-plan">Full ' + summary.steps.length + '-step pay plan ↑</a>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>';
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
