#!/usr/bin/env node
/*
 * build-site.js — Static generator for Texas Fire Salaries.
 *
 * Reads data/departments.seed.json and emits crawlable, server-rendered pages:
 *   - /departments/<slug>/index.html  (full SEO baseline + JSON-LD + embedded data)
 *   - /counties/<county>/index.html  + /counties/index.html
 *   - /regions/<region>/index.html   + /regions/index.html
 *   - /rankings/*.html               (only when enough comparable data exists)
 *   - /sitemap.xml
 *
 * Uses the SAME pure math as the browser via js/derive.js, so the crawlable text
 * matches the live page. Client JS then hydrates live Firestore data on top.
 *
 * Run: npm run build   (optionally: node scripts/build-site.js path/to/data.json)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.argv[2] || path.join(ROOT, 'data', 'departments.seed.json');
const Lib = require(path.join(ROOT, 'js', 'salary-lib.js'));
const Derive = require(path.join(ROOT, 'js', 'derive.js'));
const Agg = require(path.join(ROOT, 'js', 'aggregate.js'));

const SITE = 'https://texasfiresalaries.com';
const NOW = Date.now();

const TYPE_LABELS = {
  municipal: 'Municipal fire department', esd: 'Emergency services district', county: 'County department',
  university: 'University department', airport: 'Airport department', 'fire-rescue-district': 'Fire-rescue district',
  combination: 'Combination department', other: 'Other'
};
const CONF_CLASS = { department_maintained: 'dept', strong: 'strong', reported: 'reported', conflicting: 'conflicting', needed: 'needed' };
const FRESH_CLASS = { current: 'current', update_recommended: 'update', possibly_outdated: 'outdated', upcoming: 'upcoming', none: 'needed' };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── Asset cache-busting ──────────────────────────────────────────────────────
// Most scripts ship unversioned (only a handful carry a hand-typed date like
// nav-20260729.js), so a returning visitor kept running whatever their browser
// had cached until it expired — for a while that meant serving known-vulnerable
// code hours after the fix deployed. A date typed by hand doesn't solve it
// either: the one time someone forgets to bump it, the bug is back and silent.
//
// So the stamp is derived from the file's own bytes. Change the file and the URL
// changes; don't, and it doesn't — no diff churn on rebuilds, and nothing to
// remember. Content hashing also beats a global version string, which would
// needlessly bust every asset whenever any one of them changed.
const _stampCache = new Map();
function assetStamp(urlPath) {
  const clean = urlPath.split('?')[0];
  if (_stampCache.has(clean)) return _stampCache.get(clean);
  let stamp = '';
  try {
    const buf = fs.readFileSync(path.join(ROOT, clean.replace(/^\//, '')));
    stamp = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  } catch (e) {
    stamp = ''; // asset missing (or generated later) — leave the URL untouched
  }
  _stampCache.set(clean, stamp);
  return stamp;
}

// Rewrites every local /js/ and /css/ reference in a chunk of HTML to carry its
// content stamp. Idempotent: an existing ?v= is replaced, so re-running the
// build never layers stamps or produces a spurious diff.
function stampAssets(html) {
  return String(html).replace(/(src|href)="(\/(?:js|css)\/[^"?]+)(\?v=[^"]*)?"/g, (m, attr, p) => {
    const s = assetStamp(p);
    return s ? `${attr}="${p}?v=${s}"` : `${attr}="${p}"`;
  });
}

// Cloudflare Pages serves every "/foo.html" as "/foo" and 308-redirects the
// .html form to it, so the extensionless URL is the one that actually answers
// 200. Canonical tags and sitemap entries must name THAT url: pointing them at
// "/foo.html" makes a page whose canonical redirects (and, since the redirect
// lands back on the page declaring it, a pointless round trip for every
// crawler). Internal nav links already use the clean form; this keeps the
// machine-readable URLs consistent with them.
function cleanUrl(u) { return String(u == null ? '' : u).replace(/\.html$/, ''); }
function money(v) { return Lib.fmtMoney(v); }
function hourly(v) { return v == null ? '—' : '$' + (Math.round(v * 100) / 100).toFixed(2) + '/hr'; }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
// Every generated page goes through the stamper on its way out, so no call site
// has to remember to do it.
function write(rel, html) { const f = path.join(ROOT, rel); ensureDir(path.dirname(f)); fs.writeFileSync(f, stampAssets(html)); }

// The hand-maintained pages at the repo root (index, submit, map, the legal
// pages...) aren't generated, so they're stamped in place. Rewritten only when
// the stamp actually differs, which keeps `npm run build` a no-op in git unless
// a script or stylesheet genuinely changed.
function stampRootPages() {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
  let changed = 0;
  for (const f of files) {
    const p = path.join(ROOT, f);
    const src = fs.readFileSync(p, 'utf8');
    const out = stampAssets(src);
    if (out !== src) { fs.writeFileSync(p, out); changed++; }
  }
  return { scanned: files.length, changed };
}

function confChip(c) { return c ? `<span class="chip ${CONF_CLASS[c.key] || 'needed'}"><span class="chip-icon" aria-hidden="true">${esc(c.icon)}</span>${esc(c.label)}</span>` : ''; }
function freshChip(f) { return f ? `<span class="chip ${FRESH_CLASS[f.key] || 'needed'}"><span class="chip-icon" aria-hidden="true">${esc(f.icon)}</span>${esc(f.label)}</span>` : ''; }

// A department with a pre-rendered share card (scripts/render-dept-cards.js,
// committed PNGs) gets its own og:image; everything else shares the generic
// brand card. Checked on disk so a newly promoted department that has no card
// yet degrades gracefully instead of pointing at a 404.
function ogImageFor(slug) {
  if (slug && fs.existsSync(path.join(ROOT, 'assets', 'branding', 'dept-cards', slug + '.png'))) {
    return `/assets/branding/dept-cards/${slug}.png`;
  }
  return '/assets/branding/og-card.png';
}

const HEAD = (title, desc, canonical, extra = '', ogImage = '/assets/branding/og-card.png') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(cleanUrl(canonical))}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${SITE}${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/assets/branding/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/branding/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/branding/favicon-192.png">
  <link rel="apple-touch-icon" href="/assets/branding/favicon-180.png">
  <link rel="manifest" href="/manifest.json">
  <link rel="stylesheet" href="/css/vendor/fonts.css">
  <link rel="stylesheet" href="/css/tokens-20260729b.css">
  <link rel="stylesheet" href="/css/base-20260729b.css">
  <link rel="stylesheet" href="/css/components-20260729b.css">
  ${extra}
</head>`;

const DISCLAIMER = `<div class="notice disclaimer" style="margin:1rem 0"><span class="notice-icon" aria-hidden="true">ⓘ</span><div><strong>Community-maintained data.</strong> Compensation information may be incomplete, outdated, or incorrect, and is not officially verified. Always confirm current pay, benefits, and employment terms directly with the hiring department.</div></div>`;

// Full-page scripts for department pages (needs hydration).
const DEPT_SCRIPTS = `
  <script src="/js/salary-lib.js"></script>
  <script src="/js/consensus.js"></script>
  <script src="/js/derive.js"></script>
  <script src="/js/aggregate.js"></script>
  <script src="/js/firebase-init.js"></script>
  <script src="/js/analytics.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/data.js"></script>
  <script src="/js/ui.js"></script>
  <script src="/js/nav-20260729.js"></script>
  <script src="/js/department.js"></script>`;

const LIST_SCRIPTS = `<script src="/js/nav-20260729.js"></script>`;

// ── Department page ──────────────────────────────────────────────────────────
function departmentPage(dept) {
  const s = Derive.deriveSummary(dept, null, NOW);
  const canonical = `${SITE}/departments/${dept.slug}/`;
  const typeLabel = TYPE_LABELS[dept.departmentType] || 'Fire department';
  const title = `${dept.name} Salary and Pay Scale | Texas Fire Salaries`;
  const desc = s.hasSalary
    ? `Community-reported ${dept.name} firefighter pay: entry ${money(s.entry)}, top ${money(s.topBase)}${s.yearsToTop != null ? `, ${s.yearsToTop} years to top` : ''}. Schedule ${dept.scheduleType || '—'}. Effective ${s.effectiveDate || 'n/a'}.`
    : `${dept.name} in ${dept.city}, ${dept.county} County. Firefighter salary information has not yet been submitted — help the community by adding it.`;

  const cards = s.hasSalary ? salaryCards(s) : '';
  const compExplain = s.hasSalary ? compExplanation(s, dept.slug) : '';
  // Only render the step table when there are 3+ distinct steps; a flat/2-tier
  // plan is already conveyed by the summary cards (avoids a thin, redundant table).
  const stepTable = (s.hasSalary && s.steps && s.steps.length >= 3) ? payStepTable(s) : '';
  const facts = detailsBlock(dept, s);
  const badges = [
    dept.departmentMaintained ? '<span class="badge-dept-maintained"><span class="chip-icon" aria-hidden="true"></span>Department maintained</span>' : '',
    confChip(s.confidence), freshChip(s.freshness)
  ].join(' ');

  const hiring = dept.hiringStatus === 'hiring'
    ? '<span class="chip current"><span class="chip-icon" aria-hidden="true"></span>Currently hiring</span>'
    : (dept.hiringStatus === 'not-hiring' ? '<span class="pill">Not currently hiring</span>' : '');

  const embedded = JSON.stringify(dept).replace(/</g, '\\u003c');

  const jsonLd = s.hasSalary ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Occupation',
    name: `Firefighter — ${dept.name}`,
    description: `Community-reported firefighter compensation at ${dept.name}, ${dept.city}, Texas.`,
    occupationLocation: { '@type': 'City', name: `${dept.city}, TX` },
    estimatedSalary: [{
      '@type': 'MonetaryAmountDistribution', name: 'Base annual salary', currency: 'USD', duration: 'P1Y',
      percentile10: s.entry, median: Math.round(((s.entry || 0) + (s.topBase || 0)) / 2) || s.entry, percentile90: s.topBase
    }]
  }).replace(/</g, '\\u003c')}</script>` : '';

  const incomplete = !s.hasSalary ? `
      <div class="dept-context-note" style="margin:1.5rem 0">
        <span class="note-icon" aria-hidden="true">i</span>
        <p><strong>Current salary information has not yet been submitted.</strong> Be the first to add ${esc(dept.name)}'s firefighter pay — routine submissions publish automatically and are preserved as revisions.</p>
      </div>` : '';

  const entryDollars = s.hasSalary ? money(s.entry).replace(/^\$/, '') : '';
  const heroStat = s.hasSalary ? `
          <div class="dept-hero-stat" aria-label="Featured salary">
            <span class="dept-hero-stat-label">Firefighter base salary</span>
            <div class="dept-hero-stat-value"><sup>$</sup>${esc(entryDollars)}</div>
            ${s.effectiveHourlyEntry != null ? `<div class="dept-hero-stat-bottom"><strong>${hourly(s.effectiveHourlyEntry)}</strong><small>/ hour*</small></div>` : ''}
            ${s.annualHours ? `<p class="dept-hero-stat-note">*Effective hourly based on ${s.annualHours.toLocaleString()} scheduled annual hours.</p>` : ''}
          </div>` : `
          <div class="dept-hero-stat" aria-label="Featured salary">
            <span class="dept-hero-stat-label">Firefighter base salary</span>
            <p class="dept-hero-empty">No salary information submitted yet — be the first to add it.</p>
          </div>`;

  return HEAD(title, desc, canonical, `<link rel="stylesheet" href="/css/dept-20260805.css">${jsonLd}`, ogImageFor(dept.slug)) + `
<body data-page="departments">
  <div id="site-header"></div>
  <main id="main">
    <section id="claim-notice"></section>

    <section class="dept-hero">
      <div class="dept-hero-inner">
        <nav class="dept-breadcrumb" aria-label="Breadcrumb"><a href="/">Texas</a><span>/</span><a href="/counties/${slugify(dept.county)}/">${esc(dept.county)} County</a><span>/</span><span>${esc(dept.city)}</span></nav>
        <div class="dept-hero-grid">
          <div class="dept-hero-copy">
            <p class="eyebrow">${esc(typeLabel)}</p>
            <h1>${esc(dept.name)}</h1>
            <p class="dept-hero-loc">${esc(dept.city)}, Texas <span>•</span> ${esc(dept.county)} County <span>•</span> ${esc(regionName(dept.region))}</p>
            <div class="dept-status-row" aria-label="Data status">${badges} ${hiring}</div>
            <div class="dept-hero-buttons">
              ${Lib.safeUrl(s.sourceUrl) ? `<a class="btn btn-light" href="${esc(Lib.safeUrl(s.sourceUrl))}" rel="nofollow noopener" target="_blank">View pay plan <span aria-hidden="true">↗</span></a>` : `<a class="btn btn-light" href="/submit.html?dept=${esc(dept.slug)}&mode=update">Update information</a>`}
              <a class="btn btn-ghost-dark" href="/compare.html?d=${esc(dept.slug)}">Add to comparison <span aria-hidden="true">＋</span></a>
              ${Lib.safeUrl(dept.careersUrl) ? `<a class="btn btn-ghost-dark" href="${esc(Lib.safeUrl(dept.careersUrl))}" rel="nofollow noopener" target="_blank">Careers page ↗</a>` : ''}
              <button class="btn btn-ghost-dark" id="share-dept" type="button">Share</button>
            </div>
          </div>
${heroStat}
        </div>
      </div>
    </section>

    <div class="dept-grid">
      <div class="dept-main-column">
        ${DISCLAIMER}
        ${incomplete}
        ${s.hasSalary ? `<section id="salary" class="dept-section first">
          <div class="dept-section-heading">
            <div><span class="section-kicker">Compensation</span><h2>Salary at a glance</h2></div>
            <a href="/submit.html?dept=${esc(dept.slug)}&mode=update">Suggest an update <span aria-hidden="true">↗</span></a>
          </div>
          ${cards}
          ${compExplain}
        </section>` : `<section id="salary"></section>`}
        ${stepTable}
        ${supplementalSection(s, dept)}

        <section id="history" class="dept-section${s.hasSalary ? '' : ' first'}">
          <div class="dept-section-heading compact"><div><span class="section-kicker">Record</span><h2>History</h2></div></div>
          <div id="salary-history"></div>
          <div id="revision-history"></div>
        </section>

        <section id="details" class="dept-section">
          <div class="dept-section-heading compact"><div><span class="section-kicker">Department</span><h2>At the station</h2></div></div>
          ${facts}
        </section>

        <section id="claim-panel"></section>
      </div>

      <aside class="dept-side-column" aria-label="Data confidence">
        <div id="confidence-panel"></div>
        <a class="compare-card-link" href="/compare.html?d=${esc(dept.slug)}">
          <span>See how ${esc(dept.city)} compares</span>
          <strong>Build a department comparison <span aria-hidden="true">↗</span></strong>
        </a>
      </aside>
    </div>
  </main>
  <div id="site-footer"></div>
  <script type="application/json" id="dept-data">${embedded}</script>
  ${DEPT_SCRIPTS}
</body>
</html>`;
}

function salaryCards(s) {
  // `sub` is escaped here rather than at each call site: one of them carries the
  // shift schedule, which has been contributor-supplied free text ever since the
  // form grew an "Other / modified — describe" box, and an unescaped
  // `24/72 modified"><img src=x onerror=...>` executed on every visitor's page.
  // `val` is left raw because callers pass markup into it (e.g. `<em>yr</em>`);
  // every value passed there is derived from a number, never from typed text.
  const card = (lab, val, sub) => (val == null ? '' :
    `<article><span>${lab}</span><strong>${val}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</article>`);
  // An admin-locked field (js/admin.js's "Lock a field" tool) is pinned by
  // js/derive.js regardless of what community consensus would otherwise show —
  // called out here so a visitor isn't left wondering why it never changes.
  const lockedSub = (base, locked) => locked ? `${base} · Verified by admin` : base;
  return `<div class="salary-cards">
    ${card('Recruit pay', s.recruit != null ? money(s.recruit) : null, 'Starting / academy')}
    ${card('Firefighter entry', money(s.entry), lockedSub('Base salary', s.entryLocked))}
    ${card('Midpoint pay', s.midpoint != null ? money(s.midpoint) : null, lockedSub('Base salary', s.midpointLocked))}
    ${card('Top firefighter pay', money(s.topBase), lockedSub('Base salary', s.topLocked))}
    ${(s.entry != null && s.topBase != null && s.topBase > s.entry)
      ? card('Top pay premium', `+${money(s.topBase - s.entry)}`, `+${Math.round((s.topBase / s.entry - 1) * 1000) / 10}% over starting pay`)
      : ''}
    ${card('Years to top pay', s.yearsToTop != null ? `${s.yearsToTop} <em>yr</em>` : null, s.singleRatePlan ? 'Single-rate plan reported' : 'Reported')}
    ${card(s.annualHoursKnown ? 'Reported annual hours' : 'Assumed annual hours',
           s.annualHours ? s.annualHours.toLocaleString() : null,
           s.annualHoursKnown ? (s.scheduleType || '') : `${s.scheduleType ? s.scheduleType + ' — ' : ''}hours not reported`)}
    ${card('Effective hourly (entry)', hourly(s.effectiveHourlyEntry),
           s.annualHoursKnown ? 'Base ÷ scheduled hours' : 'Base ÷ assumed hours')}
  </div>`;
}

// Add-on pay, shown as its own section rather than folded into the salary cards.
// Keeping it visually separate is the same principle the whole site runs on:
// base pay and everything stacked on top of it never get blended into one
// number. The annualized column is what makes these figures legible — "$500/mo
// paramedic incentive" is $6,000/yr, which is the difference between two
// departments whose base pay looks identical.
function supplementalSection(s, dept) {
  const items = s.supplemental || [];
  if (!items.length) return '';
  const hours = s.annualHours || null;
  const rows = items.map(it => {
    let annual = Lib.supplementalAnnual(it);
    // Hourly add-ons only annualize if we know the schedule; percentages never
    // do, since the base they apply to changes with each step.
    if (annual == null && it.unit === 'hr' && hours) annual = it.amount * hours;
    const shown = it.unit === 'pct'
      ? `${it.amount}% of base`
      : `${money(it.amount)}/${it.unit === 'mo' ? 'mo' : it.unit === 'hr' ? 'hr' : 'yr'}`;
    return `<tr><td>${esc(Lib.supplementalLabel(it.type, it.label))}</td><td class="num">${shown}</td><td class="num">${annual != null ? money(Math.round(annual)) : '—'}</td></tr>`;
  }).join('');
  return `<section id="supplemental" class="dept-section">
    <div class="dept-section-heading">
      <div><span class="section-kicker">Add-on pay</span><h2>Supplemental pay</h2></div>
      <a href="/submit.html?dept=${esc(dept.slug)}&mode=update">Add or correct <span aria-hidden="true">↗</span></a>
    </div>
    <p class="dept-section-intro">Community-reported pay <strong>on top of</strong> base salary — certifications, education, incentives. Eligibility varies by person, so these are never added into the base figures above.</p>
    <div class="table-scroll">
      <table class="data pay-table">
        <thead><tr><th scope="col">Pay item</th><th class="num" scope="col">Reported amount</th><th class="num" scope="col">Per year</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="field-hint" style="margin-top:.6rem">Annual figures are the reported amount converted to a yearly rate${hours ? ` (hourly items use ${hours.toLocaleString()} scheduled hours)` : ''}. A percentage of base is left as-is, since the base it applies to changes with each step.</p>
  </section>`;
}

// Context the contributor typed alongside the plan ("steps from the 2026
// approved pay scale"). The form asks for it, so it has to reach the reader —
// it is often the only thing explaining which document a table came from.
function planNotes(s) {
  if (!s.planNotes) return '';
  return `<p class="field-hint" style="margin-top:.75rem"><strong>Contributor note:</strong> ${esc(s.planNotes)}</p>`;
}

function compExplanation(s, slug) {
  const warn = s.includesScheduledOvertime
    ? `<div class="notice warn" style="margin-top:1rem"><span class="notice-icon" aria-hidden="true">⚠</span><div>This department's reported annual compensation may include <strong>scheduled overtime</strong>. Compare base salary and annual hours before comparing it with departments that report base pay only.</div></div>`
    : '';
  // Worded without presuming a step plan exists: for many small departments a
  // single rate IS the whole pay structure, and permanently begging for steps
  // nobody can supply would present a complete page as an unfinished one.
  const singleRate = s.singleRatePlan
    ? `<div class="notice warn" style="margin-top:1rem"><span class="notice-icon" aria-hidden="true">ⓘ</span><div><strong>Single pay rate on file.</strong> One rate has been reported for this department — that may be its whole pay structure, or a step plan that just hasn't been submitted yet. <a href="/submit.html?dept=${esc(slug || '')}&mode=step">Know the pay steps? Add them →</a></div></div>`
    : '';
  return `<div class="dept-context-note">
    <span class="note-icon" aria-hidden="true">i</span>
    <p><strong>About these numbers.</strong> Base salary is shown separately from reported total compensation, which can include scheduled overtime, paramedic, certification, education, longevity, assignment, and holiday pay.</p>
  </div>
  ${warn}${singleRate}`;
}

function payStepTable(s) {
  const has = (key) => s.steps.some(st => Lib.parseMoney(st[key]) != null);
  const cols = [
    ['stepName', 'Step', false], ['minimumMonths', 'Time in service', true],
    ['baseAnnualSalary', 'Base annual', true], ['scheduledOvertime', 'Scheduled OT', true],
    ['paramedicPay', 'Paramedic', true], ['reportedAnnualCompensation', 'Reported total', true]
  ].filter(([k]) => k === 'stepName' || k === 'minimumMonths' || has(k));
  const head = cols.map(([, label, num]) => `<th${num ? ' class="num"' : ''} scope="col">${label}</th>`).join('');
  const rows = s.steps.map((st, i) => {
    const isTop = i === s.steps.length - 1;
    const tds = cols.map(([k, , num]) => {
      let v;
      if (k === 'stepName') v = esc(st.stepName || `Step ${i + 1}`);
      else if (k === 'minimumMonths') v = st.minimumMonths != null ? monthsLabel(st.minimumMonths) : '—';
      else v = money(Lib.parseMoney(st[k]));
      return `<td${num ? ' class="num"' : ''}>${v}</td>`;
    }).join('');
    return `<tr${isTop ? ' class="top-step"' : ''}>${tds}</tr>`;
  }).join('');
  // A flag doesn't hide the plan — it stays visible, marked disputed, until
  // enough distinct community members flag it (see extractStepPlans() in
  // scripts/export-overlay.js for the revert threshold).
  const disputeNotice = s.stepPlanDisputed
    ? `<div class="notice warn" style="margin-top:.75rem"><span class="notice-icon" aria-hidden="true">⚠</span><div>Disputed — flagged as possibly incorrect by ${s.stepPlanDisputeCount} community member${s.stepPlanDisputeCount === 1 ? '' : 's'}. It will be reverted to the prior data if enough others agree.</div></div>`
    : '';
  // Only a live community submission has an ID to flag against — seed/starter
  // data has nothing to target, so no button renders for it.
  const flag = s.stepPlanId ? `<div style="margin-top:.6rem">
    <button class="btn btn-outline btn-sm" id="flag-step-plan" data-step-plan-id="${esc(s.stepPlanId)}">⚑ Flag this pay-step plan</button>
    <div id="flag-step-plan-status" class="field-hint" style="margin-top:.4rem"></div>
  </div>` : '';
  return `<section id="step-plan" class="dept-section">
    <div class="dept-section-heading"><div><span class="section-kicker">Pay-step plan</span><h2>Full pay schedule</h2></div></div>
    <p class="dept-section-intro">Reported step schedule${s.classification ? ` for the ${esc(s.classification)} classification` : ''}. Only submitted columns are shown.</p>
    ${disputeNotice}
    <div class="table-scroll"><table class="data"><caption class="visually-hidden">Pay steps</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${planNotes(s)}${flag}</section>`;
}
function monthsLabel(m) { if (m === 0) return 'Start'; const y = Math.floor(m / 12); const mo = m % 12; return (y ? `${y} yr` : '') + (mo ? ` ${mo} mo` : '') || `${m} mo`; }

// "2026-01-15" -> "01/15/2026", by pattern rather than by Date parsing: an ISO
// day string parses as UTC midnight, so formatting it in local time renders the
// previous day west of Greenwich.
function fmtDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || null); }

function detailsBlock(dept, s) {
  // Numeric/short facts get the big mono stat treatment (matches salary
  // cards); longer text facts (dept type, retirement system name) use the
  // smaller sans "detail-text" style instead of trying to force them into
  // the same oversized mono numerals.
  const rows = [
    ['Shift schedule', dept.scheduleType, false], ['Scheduled annual hours', dept.annualScheduledHours ? dept.annualScheduledHours.toLocaleString() : null, false],
    // Read off the derived summary, not the seed record, so a date supplied by a
    // community submission is the one shown.
    ['Pay plan effective', s ? fmtDate(s.effectiveDate) : null, false],
    ['Number of stations', dept.stations, false], ['Ambulance transport', dept.transportStatus === 'transport' ? 'Transports patients' : (dept.transportStatus === 'non-transport' ? 'Non-transport' : null), true],
    ['Civil service', dept.civilService == null ? null : (dept.civilService ? 'Yes' : 'No'), false],
    ['Retirement system', dept.retirementSystem, true], ['Department type', TYPE_LABELS[dept.departmentType], true],
    ['EMT required', dept.flags && dept.flags.emtRequired ? 'Yes' : null, false], ['Paramedic required', dept.flags && dept.flags.paramedicRequired ? 'Yes' : null, false],
    ['Accepts laterals', dept.flags && dept.flags.lateralsAccepted ? 'Yes' : null, false], ['ZIP', dept.zip, true]
  ].filter(([, v]) => v != null && v !== '');
  if (!rows.length) return '<p class="dept-section-intro">No additional department facts on file yet.</p>';
  // The per-row isText flag can't know how long a value will actually be. A
  // shift schedule is "24/48" for most departments — properly a big mono stat —
  // but "Modified 24-hour Schedule (24 on, 72 off; 48 on, 72 off)" for some, and
  // that cannot wear the same treatment. Length decides, so the same field
  // renders correctly whichever kind of value a department reports.
  const valueClass = (v, isText) => {
    const len = String(v).length;
    if (len > 26) return ' class="detail-long"';
    return isText ? ' class="detail-text"' : '';
  };
  const cards = rows.map(([k, v, isText], i) =>
    `<div class="detail-card${i === 0 ? ' accent-card' : ''}"><span class="detail-label">${esc(k)}</span><strong${valueClass(v, isText)}>${esc(v)}</strong></div>`).join('');
  return `<div class="detail-grid">${cards}</div>
    ${Lib.safeUrl(dept.website) ? `<p style="margin:1rem 0 0"><a href="${esc(Lib.safeUrl(dept.website))}" rel="nofollow noopener" target="_blank">Department website ↗</a></p>` : ''}`;
}

// ── List pages (counties, regions, rankings) ─────────────────────────────────
let REGIONS = {};
function regionName(id) { return REGIONS[id] || id; }

function miniCard(dept) {
  const s = Derive.deriveSummary(dept, null, NOW);
  const metric = s.hasSalary ? `${money(s.entry)} entry · ${money(s.topBase)} top` : 'Salary data needed';
  return `<article class="card card-hover dept-card${s.hasSalary ? '' : ' incomplete'}">
    <div class="type-tag">${esc((TYPE_LABELS[dept.departmentType] || 'Dept').split(' ')[0])}</div>
    <h3><a href="/departments/${esc(dept.slug)}/">${esc(dept.name)}</a></h3>
    <div class="loc">${esc(dept.city)} · ${esc(dept.county)} County</div>
    <div class="muted" style="font-weight:600">${metric}</div>
    <div class="tag-row">${confChip(s.confidence)} ${freshChip(s.freshness)}</div>
  </article>`;
}

function listPage(title, desc, canonical, heading, intro, depts) {
  return HEAD(title, desc, canonical) + `
<body data-page="departments">
  <div id="site-header"></div>
  <main id="main" class="wrap section-sm">
    <p class="eyebrow">Directory</p>
    <h1>${esc(heading)}</h1>
    <p class="lede">${esc(intro)}</p>
    ${DISCLAIMER}
    <div class="grid cols-3" style="margin-top:1.5rem">${depts.map(miniCard).join('')}</div>
    <p style="margin-top:2rem"><a class="btn btn-outline" href="/departments.html">Browse the full directory →</a></p>
  </main>
  <div id="site-footer"></div>
  ${LIST_SCRIPTS}
</body>
</html>`;
}

function hubPage(title, heading, intro, canonical, links) {
  return HEAD(title, intro, canonical) + `
<body data-page="departments">
  <div id="site-header"></div>
  <main id="main" class="wrap section-sm">
    <p class="eyebrow">Directory</p>
    <h1>${esc(heading)}</h1>
    <p class="lede">${esc(intro)}</p>
    <div class="grid cols-3" style="margin-top:1.5rem">${links.map(l =>
      `<a class="card card-hover" href="${esc(l.href)}"><strong>${esc(l.label)}</strong><div class="muted" style="font-size:.85rem">${esc(l.sub)}</div></a>`).join('')}</div>
  </main>
  <div id="site-footer"></div>
  ${LIST_SCRIPTS}
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function loadOverlay() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'overlay.json'), 'utf8')); }
  catch (e) { return { reports: {} }; }
}

function main() {
  const json = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const overlay = loadOverlay();                       // static community consensus
  const oReports = overlay.reports || {};
  const oDepartments = overlay.departments || [];       // auto-promoted, ZIP-geocoded new departments
  const oStepPlans = overlay.stepPlans || {};           // live, community-submitted full pay-step plans
  const oClaimedSlugs = new Set(overlay.claimedSlugs || []); // admin-approved "Department maintained" claims
  const oCivilService = overlay.civilService || {};     // optional dept-level fact from a submission
const oDeptFacts = overlay.deptFacts || {};           // schedule / scheduled annual hours, same source
  const oDeptOverrides = overlay.departmentOverrides || {}; // admin name/coordinate corrections + duplicate merges
  const oFieldLocks = overlay.fieldLocks || {};          // admin-pinned entry/top/midpoint values
  const oSuspended = new Set(overlay.suspendedContributorIds || []); // spam/abuse contributors, reports excluded
  const oMergedRedirects = overlay.mergedRedirects || []; // duplicate department -> canonical department
  // Merge community reports into each department ONCE, up front, so every page,
  // ranking, and embedded blob reflects consensus. Visitors read only static files.
  const depts = (json.departments || []).concat(oDepartments).map(d => {
    let merged = Agg.applyOverlay(d, oReports[d.slug]);
    merged = Agg.applySupplementalFlags(merged);
    merged = Agg.applySuspensions(merged, oSuspended);
    if (oStepPlans[d.slug]) merged = Agg.applyStepPlan(merged, oStepPlans[d.slug]);
    if (oClaimedSlugs.has(d.slug)) merged = Agg.applyClaim(merged, true);
    if (Object.prototype.hasOwnProperty.call(oCivilService, d.slug)) merged = Agg.applyCivilService(merged, oCivilService[d.slug]);
    if (oDeptFacts[d.slug]) merged = Agg.applyDeptFacts(merged, oDeptFacts[d.slug]);
    if (oDeptOverrides[d.slug]) merged = Agg.applyDeptOverride(merged, oDeptOverrides[d.slug]);
    if (oFieldLocks[d.slug]) merged = Agg.applyFieldOverrides(merged, oFieldLocks[d.slug]);
    return merged;
  });
  const communityCount = Object.keys(oReports).filter(k => (oReports[k] || []).length).length;
  REGIONS = {}; (json.regions || []).forEach(r => { REGIONS[r.id] = r.name; });
  // Evergreen pages. The legal/about set is indexable and linked from every
  // footer, so it belongs in the sitemap; admin.html and sign-in.html are
  // deliberately excluded (both are noindex + disallowed in robots.txt).
  const urls = ['/', '/map.html', '/departments.html', '/compare.html', '/submit.html', '/how-it-works.html',
    '/about.html', '/terms.html', '/privacy-policy.html', '/disclaimer.html', '/community-policy.html', '/claim-policy.html'];

  // A department marked as a duplicate is dropped from every listing/ranking/
  // sitemap below and gets a 301 via Cloudflare Pages' native _redirects file
  // instead of its own generated page — see the mergedRedirects write near the
  // end of this function.
  const mergedFromSlugs = new Set(oMergedRedirects.map(r => r.from));
  const liveDepts = depts.filter(d => !mergedFromSlugs.has(d.slug));

  // Department pages
  liveDepts.forEach(d => { write(`departments/${d.slug}/index.html`, departmentPage(d)); urls.push(`/departments/${d.slug}/`); });

  // Counties
  const byCounty = groupBy(liveDepts, d => d.county);
  const countyLinks = [];
  Object.keys(byCounty).sort().forEach(county => {
    const cslug = slugify(county);
    const list = byCounty[county].sort(byName);
    write(`counties/${cslug}/index.html`, listPage(
      `${county} County Fire Department Salaries | Texas Fire Salaries`,
      `Firefighter pay for fire departments in ${county} County, Texas — community reported.`,
      `${SITE}/counties/${cslug}/`, `${county} County fire departments`,
      `Community-reported firefighter compensation for ${list.length} department${list.length === 1 ? '' : 's'} in ${county} County, Texas.`, list));
    urls.push(`/counties/${cslug}/`);
    countyLinks.push({ href: `/counties/${cslug}/`, label: `${county} County`, sub: `${list.length} department${list.length === 1 ? '' : 's'}` });
  });
  write('counties/index.html', hubPage('Texas Fire Departments by County | Texas Fire Salaries',
    'Fire departments by county', 'Browse Texas fire departments grouped by county.', `${SITE}/counties/`, countyLinks));
  urls.push('/counties/');

  // Regions
  const byRegion = groupBy(liveDepts, d => d.region);
  const regionLinks = [];
  Object.keys(byRegion).forEach(region => {
    const list = byRegion[region].sort(byName);
    write(`regions/${region}/index.html`, listPage(
      `${regionName(region)} Firefighter Salaries | Texas Fire Salaries`,
      `Firefighter pay across ${regionName(region)} — community reported.`,
      `${SITE}/regions/${region}/`, `${regionName(region)} fire departments`,
      `Community-reported firefighter compensation across ${regionName(region)} (${list.length} departments).`, list));
    urls.push(`/regions/${region}/`);
    regionLinks.push({ href: `/regions/${region}/`, label: regionName(region), sub: `${list.length} departments` });
  });
  write('regions/index.html', hubPage('Texas Fire Departments by Region | Texas Fire Salaries',
    'Fire departments by region', 'Browse Texas fire departments grouped by region.', `${SITE}/regions/`, regionLinks));
  urls.push('/regions/');

  // A ranked list is only ever "highest" among departments actually in the
  // database, so the scope is stated in the intro rather than implying a
  // statewide superlative. Derived from the real data (same idea as the
  // homepage coverage note) so it stops naming one region automatically once
  // a second region has departments.
  const rankedRegions = Object.keys(byRegion);
  const COVERAGE_PHRASE = rankedRegions.length === 1
    ? `among the ${liveDepts.length} departments currently listed in ${regionName(rankedRegions[0])}`
    : `among the ${liveDepts.length} departments currently listed`;

  // Rankings — only when enough comparable data exists (>= 3 departments).
  const withEntry = liveDepts.map(d => ({ d, s: Derive.deriveSummary(d, null, NOW) })).filter(x => x.s.hasSalary && x.s.entry != null);
  const rankings = [];
  if (withEntry.length >= 3) {
    const top = withEntry.slice().sort((a, b) => b.s.entry - a.s.entry).map(x => x.d);
    write('rankings/highest-entry-pay.html', listPage(
      'Highest Reported Entry Firefighter Salaries | Texas Fire Salaries',
      'Listed Texas fire departments with the highest community-reported entry firefighter pay.',
      `${SITE}/rankings/highest-entry-pay.html`, 'Highest reported entry firefighter salaries',
      `Ranked by community-reported base entry pay ${COVERAGE_PHRASE}. Base salary only — schedules and incentives vary, so compare carefully.`, top));
    urls.push('/rankings/highest-entry-pay.html');
    rankings.push({ href: '/rankings/highest-entry-pay.html', label: 'Highest entry pay', sub: 'By base entry salary' });
  }
  const hiring = liveDepts.filter(d => d.hiringStatus === 'hiring').sort(byName);
  if (hiring.length >= 3) {
    write('rankings/currently-hiring.html', listPage(
      'Texas Fire Departments Currently Hiring | Texas Fire Salaries',
      'Texas fire departments reported to be currently hiring firefighters.',
      `${SITE}/rankings/currently-hiring.html`, 'Departments currently hiring',
      `Community-reported hiring status ${COVERAGE_PHRASE} — confirm openings directly with each department.`, hiring));
    urls.push('/rankings/currently-hiring.html');
    rankings.push({ href: '/rankings/currently-hiring.html', label: 'Currently hiring', sub: `${hiring.length} departments` });
  }
  const recent = withEntry.filter(x => x.s.lastUpdated && (NOW - x.s.lastUpdated) < 365 * 864e5)
    .sort((a, b) => b.s.lastUpdated - a.s.lastUpdated).map(x => x.d);
  if (recent.length >= 3) {
    write('rankings/recently-updated.html', listPage(
      'Recently Updated Texas Firefighter Salaries | Texas Fire Salaries',
      'Texas fire departments whose firefighter pay was most recently updated by the community.',
      `${SITE}/rankings/recently-updated.html`, 'Recently updated departments',
      `Departments with the freshest community reports in the last 12 months, ${COVERAGE_PHRASE}.`, recent));
    urls.push('/rankings/recently-updated.html');
    rankings.push({ href: '/rankings/recently-updated.html', label: 'Recently updated', sub: 'Last 12 months' });
  }
  // Schedule pages
  ['24/48', '48/96', '24/72'].forEach(sch => {
    const list = liveDepts.filter(d => d.scheduleType === sch).sort(byName);
    if (list.length < 3) return;
    const sslug = 'schedule-' + sch.replace('/', '-');
    write(`rankings/${sslug}.html`, listPage(
      `Texas Fire Departments on a ${sch} Schedule | Texas Fire Salaries`,
      `Texas fire departments reported to work a ${sch} shift schedule.`,
      `${SITE}/rankings/${sslug}.html`, `Departments with ${sch} schedules`,
      `Community-reported fire departments working a ${sch} shift cycle, ${COVERAGE_PHRASE}.`, list));
    urls.push(`/rankings/${sslug}.html`);
    rankings.push({ href: `/rankings/${sslug}.html`, label: `${sch} schedule`, sub: `${list.length} departments` });
  });
  if (rankings.length) { write('rankings/index.html', hubPage('Texas Firefighter Salary Rankings | Texas Fire Salaries', 'Salary rankings & lists', `Ranked lists are published only when enough comparable data exists, and cover only departments already in the database (${rankedRegions.length === 1 ? regionName(rankedRegions[0]) : rankedRegions.length + ' regions'} so far).`, `${SITE}/rankings/`, rankings)); urls.push('/rankings/'); }

  // Sitemap
  write('sitemap.xml', sitemap(urls));
  const stamped = stampRootPages();
  console.log(`Asset stamps: ${stamped.changed} of ${stamped.scanned} root page(s) updated (content-hashed /js and /css URLs).`);

  // Duplicate-department redirects (js/admin.js's "Merge duplicate department"
  // tool) — appended to the hand-maintained _redirects file inside a clearly
  // marked block so a rebuild replaces just that block, not any redirects
  // someone added by hand above it.
  writeMergeRedirects(oMergedRedirects);

  console.log(`Built ${liveDepts.length} department pages, ${Object.keys(byCounty).length} counties, ${Object.keys(byRegion).length} regions, ${rankings.length} ranking pages.` +
    (mergedFromSlugs.size ? ` ${mergedFromSlugs.size} merged-duplicate page(s) redirect instead.` : ''));
  console.log(`Community overlay: ${communityCount} department(s) with community reports merged.`);
  console.log(`Sitemap: ${urls.length} URLs -> sitemap.xml`);
}

const REDIRECTS_BEGIN = '# --- BEGIN auto-generated department merges (scripts/build-site.js — do not hand-edit this block) ---';
const REDIRECTS_END = '# --- END auto-generated department merges ---';
function writeMergeRedirects(mergedRedirects) {
  const file = path.join(ROOT, '_redirects');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch (e) { /* file doesn't exist yet */ }
  const beginIdx = existing.indexOf(REDIRECTS_BEGIN);
  const base = (beginIdx === -1 ? existing : existing.slice(0, beginIdx)).replace(/\s*$/, '\n');
  if (!mergedRedirects.length) { fs.writeFileSync(file, base); return; }
  const block = [REDIRECTS_BEGIN,
    ...mergedRedirects.map(r => `/departments/${r.from}/  /departments/${r.to}/  301`),
    REDIRECTS_END].join('\n');
  fs.writeFileSync(file, base + '\n' + block + '\n');
}

function sitemap(urls) {
  const today = new Date().toISOString().slice(0, 10);
  const body = [...new Set(urls.map(cleanUrl))].map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
function groupBy(arr, fn) { const o = {}; arr.forEach(x => { const k = fn(x); if (!k) return; (o[k] = o[k] || []).push(x); }); return o; }
function byName(a, b) { return a.name.localeCompare(b.name); }

main();
