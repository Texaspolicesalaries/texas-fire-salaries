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
function money(v) { return Lib.fmtMoney(v); }
function hourly(v) { return v == null ? '—' : '$' + (Math.round(v * 100) / 100).toFixed(2) + '/hr'; }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function write(rel, html) { const f = path.join(ROOT, rel); ensureDir(path.dirname(f)); fs.writeFileSync(f, html); }

function confChip(c) { return c ? `<span class="chip ${CONF_CLASS[c.key] || 'needed'}"><span class="chip-icon" aria-hidden="true">${esc(c.icon)}</span>${esc(c.label)}</span>` : ''; }
function freshChip(f) { return f ? `<span class="chip ${FRESH_CLASS[f.key] || 'needed'}"><span class="chip-icon" aria-hidden="true">${esc(f.icon)}</span>${esc(f.label)}</span>` : ''; }

const HEAD = (title, desc, canonical, extra = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
    ? `Community-reported ${dept.name} firefighter pay: entry ${money(s.entry)}, top ${money(s.topBase)}${s.yearsToTop != null ? `, ${s.yearsToTop} years to top` : ''}. Schedule ${dept.scheduleType || '—'}. Effective ${dept.salary.effectiveDate || 'n/a'}.`
    : `${dept.name} in ${dept.city}, ${dept.county} County. Firefighter salary information has not yet been submitted — help the community by adding it.`;

  const cards = s.hasSalary ? salaryCards(s) : '';
  const compExplain = s.hasSalary ? compExplanation(s) : '';
  // Only render the step table when there are 3+ distinct steps; a flat/2-tier
  // plan is already conveyed by the summary cards (avoids a thin, redundant table).
  const stepTable = (s.hasSalary && s.steps && s.steps.length >= 3) ? payStepTable(s) : '';
  const facts = detailsBlock(dept);
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
      <div class="card" style="text-align:center;padding:2.5rem 1.5rem;margin:1.5rem 0">
        <h2 style="margin-bottom:.5rem">Current salary information has not yet been submitted.</h2>
        <p class="muted" style="max-width:46ch;margin:0 auto 1.25rem">Be the first to add ${esc(dept.name)}'s firefighter pay. Routine submissions publish automatically and are preserved as revisions.</p>
        <a class="btn btn-primary btn-lg" href="/submit.html?dept=${esc(dept.slug)}">Add salary information</a>
      </div>` : '';

  return HEAD(title, desc, canonical, jsonLd) + `
<body data-page="departments">
  <div id="site-header"></div>
  <main id="main" class="wrap section-sm">
    <section id="claim-notice"></section>
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/departments.html">Departments</a> › <a href="/counties/${slugify(dept.county)}/">${esc(dept.county)} County</a> › <span>${esc(dept.name)}</span></nav>

    <header style="margin-bottom:1rem">
      <p class="eyebrow">${esc(typeLabel)}</p>
      <h1 style="margin-bottom:.4rem">${esc(dept.name)}</h1>
      <p class="lede" style="margin-bottom:.75rem">${esc(dept.city)}, ${esc(dept.county)} County · ${regionName(dept.region)}</p>
      <div class="tag-row" style="margin-bottom:.5rem">${badges} ${hiring}</div>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem">
        <a class="btn btn-primary" href="/submit.html?dept=${esc(dept.slug)}&mode=update">Update information</a>
        ${s.sourceUrl ? `<a class="btn btn-outline" href="${esc(s.sourceUrl)}" rel="nofollow noopener" target="_blank">📄 View pay plan ↗</a>` : ''}
        ${dept.careersUrl ? `<a class="btn btn-outline" href="${esc(dept.careersUrl)}" rel="nofollow noopener" target="_blank">Careers page ↗</a>` : ''}
        <a class="btn btn-outline" href="/compare.html?d=${esc(dept.slug)}">Add to comparison</a>
      </div>
    </header>

    ${DISCLAIMER}
    ${incomplete}
    ${s.hasSalary ? `<section style="margin:1.5rem 0"><h2>Salary summary</h2>${cards}</section>` : ''}
    ${compExplain}
    ${stepTable}

    <section id="career-earnings" style="margin:2rem 0"></section>
    <section id="salary-history" style="margin:2rem 0"></section>

    <section style="margin:2rem 0"><h2>Department details</h2>${facts}</section>

    <section id="confidence-panel" style="margin:2rem 0"></section>
    <section id="revision-history" style="margin:2rem 0"></section>
    <section id="claim-panel" style="margin:2rem 0"></section>
  </main>
  <div id="site-footer"></div>
  <script type="application/json" id="dept-data">${embedded}</script>
  ${DEPT_SCRIPTS}
</body>
</html>`;
}

function salaryCards(s) {
  const card = (lab, val, sub, accent) => (val == null ? '' :
    `<div class="salary-card${accent ? ' accent' : ''}"><div class="sc-lab">${lab}</div><div class="sc-val">${val}</div>${sub ? `<div class="sc-sub">${sub}</div>` : ''}</div>`);
  return `<div class="salary-grid" style="margin-top:1rem">
    ${card('Recruit pay', s.recruit != null ? money(s.recruit) : null, 'Starting / academy')}
    ${card('Firefighter entry', money(s.entry), 'Base salary', true)}
    ${card('Midpoint pay', s.midpoint != null ? money(s.midpoint) : null, 'Base salary')}
    ${card('Top firefighter pay', money(s.topBase), 'Base salary')}
    ${card('Years to top pay', s.yearsToTop != null ? s.yearsToTop + ' yr' : null, 'Reported')}
    ${card('Reported annual hours', s.annualHours ? s.annualHours.toLocaleString() : null, s.scheduleType || '')}
    ${card('Effective hourly (entry)', hourly(s.effectiveHourlyEntry), 'Base ÷ scheduled hours')}
  </div>`;
}

function compExplanation(s) {
  const warn = s.includesScheduledOvertime
    ? `<div class="notice warn" style="margin-top:1rem"><span class="notice-icon" aria-hidden="true">⚠</span><div>This department's reported annual compensation may include <strong>scheduled overtime</strong>. Compare base salary and annual hours before comparing it with departments that report base pay only.</div></div>`
    : '';
  return `<section style="margin:1.5rem 0">
    <h2>Understanding the numbers</h2>
    <p class="muted">We keep <strong>base salary</strong> separate from <strong>reported total compensation</strong> (base + scheduled overtime + paramedic, certification, education, longevity, assignment, and holiday pay). Figures shown as “base” exclude overtime and incentives.</p>
    ${warn}
  </section>`;
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
  return `<section style="margin:1.5rem 0"><h2>Pay-step plan</h2>
    <p class="muted">Reported step schedule${s.classification ? ` for the ${esc(s.classification)} classification` : ''}. Only submitted columns are shown.</p>
    ${disputeNotice}
    <div class="table-scroll"><table class="data"><caption class="visually-hidden">Pay steps</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${flag}</section>`;
}
function monthsLabel(m) { if (m === 0) return 'Start'; const y = Math.floor(m / 12); const mo = m % 12; return (y ? `${y} yr` : '') + (mo ? ` ${mo} mo` : '') || `${m} mo`; }

function detailsBlock(dept) {
  const rows = [
    ['Shift schedule', dept.scheduleType], ['Scheduled annual hours', dept.annualScheduledHours ? dept.annualScheduledHours.toLocaleString() : null],
    ['Number of stations', dept.stations], ['Ambulance transport', dept.transportStatus === 'transport' ? 'Transports patients' : (dept.transportStatus === 'non-transport' ? 'Non-transport' : null)],
    ['Civil service', dept.civilService == null ? null : (dept.civilService ? 'Yes' : 'No')],
    ['Retirement system', dept.retirementSystem], ['Department type', TYPE_LABELS[dept.departmentType]],
    ['EMT required', dept.flags && dept.flags.emtRequired ? 'Yes' : null], ['Paramedic required', dept.flags && dept.flags.paramedicRequired ? 'Yes' : null],
    ['Accepts laterals', dept.flags && dept.flags.lateralsAccepted ? 'Yes' : null], ['ZIP', dept.zip]
  ].filter(([, v]) => v != null && v !== '');
  return `<div class="card"><div class="grid cols-2">${rows.map(([k, v]) =>
    `<div class="conf-stat"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>
    ${dept.website ? `<p style="margin:1rem 0 0"><a href="${esc(dept.website)}" rel="nofollow noopener" target="_blank">Department website ↗</a></p>` : ''}</div>`;
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
  // Merge community reports into each department ONCE, up front, so every page,
  // ranking, and embedded blob reflects consensus. Visitors read only static files.
  const depts = (json.departments || []).concat(oDepartments).map(d => {
    let merged = Agg.applyOverlay(d, oReports[d.slug]);
    merged = Agg.applySupplementalFlags(merged);
    if (oStepPlans[d.slug]) merged = Agg.applyStepPlan(merged, oStepPlans[d.slug]);
    if (oClaimedSlugs.has(d.slug)) merged = Agg.applyClaim(merged, true);
    if (Object.prototype.hasOwnProperty.call(oCivilService, d.slug)) merged = Agg.applyCivilService(merged, oCivilService[d.slug]);
    return merged;
  });
  const communityCount = Object.keys(oReports).filter(k => (oReports[k] || []).length).length;
  REGIONS = {}; (json.regions || []).forEach(r => { REGIONS[r.id] = r.name; });
  const urls = ['/', '/map.html', '/departments.html', '/compare.html', '/submit.html', '/how-it-works.html'];

  // Department pages
  depts.forEach(d => { write(`departments/${d.slug}/index.html`, departmentPage(d)); urls.push(`/departments/${d.slug}/`); });

  // Counties
  const byCounty = groupBy(depts, d => d.county);
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
  const byRegion = groupBy(depts, d => d.region);
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

  // Rankings — only when enough comparable data exists (>= 3 departments).
  const withEntry = depts.map(d => ({ d, s: Derive.deriveSummary(d, null, NOW) })).filter(x => x.s.hasSalary && x.s.entry != null);
  const rankings = [];
  if (withEntry.length >= 3) {
    const top = withEntry.slice().sort((a, b) => b.s.entry - a.s.entry).map(x => x.d);
    write('rankings/highest-entry-pay.html', listPage(
      'Highest Reported Entry Firefighter Salaries in Texas | Texas Fire Salaries',
      'Texas fire departments with the highest community-reported entry firefighter pay.',
      `${SITE}/rankings/highest-entry-pay.html`, 'Highest reported entry firefighter salaries',
      'Ranked by community-reported base entry pay. Base salary only — schedules and incentives vary, so compare carefully.', top));
    urls.push('/rankings/highest-entry-pay.html');
    rankings.push({ href: '/rankings/highest-entry-pay.html', label: 'Highest entry pay', sub: 'By base entry salary' });
  }
  const hiring = depts.filter(d => d.hiringStatus === 'hiring').sort(byName);
  if (hiring.length >= 3) {
    write('rankings/currently-hiring.html', listPage(
      'Texas Fire Departments Currently Hiring | Texas Fire Salaries',
      'Texas fire departments reported to be currently hiring firefighters.',
      `${SITE}/rankings/currently-hiring.html`, 'Departments currently hiring',
      'Community-reported hiring status — confirm openings directly with each department.', hiring));
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
      'Departments with the freshest community reports in the last 12 months.', recent));
    urls.push('/rankings/recently-updated.html');
    rankings.push({ href: '/rankings/recently-updated.html', label: 'Recently updated', sub: 'Last 12 months' });
  }
  // Schedule pages
  ['24/48', '48/96', '24/72'].forEach(sch => {
    const list = depts.filter(d => d.scheduleType === sch).sort(byName);
    if (list.length < 3) return;
    const sslug = 'schedule-' + sch.replace('/', '-');
    write(`rankings/${sslug}.html`, listPage(
      `Texas Fire Departments on a ${sch} Schedule | Texas Fire Salaries`,
      `Texas fire departments reported to work a ${sch} shift schedule.`,
      `${SITE}/rankings/${sslug}.html`, `Departments with ${sch} schedules`,
      `Community-reported fire departments working a ${sch} shift cycle.`, list));
    urls.push(`/rankings/${sslug}.html`);
    rankings.push({ href: `/rankings/${sslug}.html`, label: `${sch} schedule`, sub: `${list.length} departments` });
  });
  if (rankings.length) { write('rankings/index.html', hubPage('Texas Firefighter Salary Rankings | Texas Fire Salaries', 'Salary rankings & lists', 'Ranked lists are published only when enough comparable data exists.', `${SITE}/rankings/`, rankings)); urls.push('/rankings/'); }

  // Sitemap
  write('sitemap.xml', sitemap(urls));

  console.log(`Built ${depts.length} department pages, ${Object.keys(byCounty).length} counties, ${Object.keys(byRegion).length} regions, ${rankings.length} ranking pages.`);
  console.log(`Community overlay: ${communityCount} department(s) with community reports merged.`);
  console.log(`Sitemap: ${urls.length} URLs -> sitemap.xml`);
}

function sitemap(urls) {
  const today = new Date().toISOString().slice(0, 10);
  const body = [...new Set(urls)].map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
function groupBy(arr, fn) { const o = {}; arr.forEach(x => { const k = fn(x); if (!k) return; (o[k] = o[k] || []).push(x); }); return o; }
function byName(a, b) { return a.name.localeCompare(b.name); }

main();
