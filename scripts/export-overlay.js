#!/usr/bin/env node
/*
 * export-overlay.js — Regenerate data/overlay.json from Firestore. NO SECRET NEEDED.
 *
 * Published submissions are public-read per firestore.rules, so this reads them via
 * the Firestore REST API using only the public web API key (the same one already in
 * js/firebase-init.js). That means the refresh loop can run anywhere — locally, in
 * CI, or in the Cloudflare Pages build — with zero credentials to manage.
 *
 * Resilient by design: on ANY error it leaves the existing overlay.json untouched
 * and exits 0, so a scheduled build is never broken by a transient Firestore hiccup.
 *
 * Usage:  node scripts/export-overlay.js        (then `npm run build`, or just `npm run refresh`)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'overlay.json');
const INIT = path.join(ROOT, 'js', 'firebase-init.js');
const SEED = path.join(ROOT, 'data', 'departments.seed.json');

// Single source of truth: pull projectId + apiKey out of firebase-init.js.
function readConfig() {
  const src = fs.readFileSync(INIT, 'utf8');
  const projectId = (src.match(/projectId:\s*["']([^"']+)["']/) || [])[1];
  const apiKey = (src.match(/apiKey:\s*["']([^"']+)["']/) || [])[1];
  return { projectId, apiKey };
}

// The ZIP-centroid table ships as a dated, cache-busted browser file
// (js/texas-zips-YYYYMMDD.js exposing window.TexasZipCentroids) — pick whichever
// one currently exists rather than hardcoding a filename that will drift.
function readZipCentroids() {
  const dir = path.join(ROOT, 'js');
  const file = fs.readdirSync(dir).filter(f => /^texas-zips.*\.js$/.test(f)).sort().pop();
  if (!file) return {};
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const m = src.match(/window\.TexasZipCentroids\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { return {}; }
}

function money(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}
function isoDay(ts) { try { const d = ts ? new Date(ts) : null; return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null; } catch (e) { return null; } }
// Firestore REST wraps values as { stringValue | integerValue | doubleValue | booleanValue | ... }
function fv(x) { if (!x) return undefined; return x.stringValue ?? x.integerValue ?? x.doubleValue ?? x.booleanValue ?? undefined; }

// Which displayed figure a quick-update `amount` refers to, from its salary type.
// Top types -> top pay; hourly -> skip (unit mismatch); everything else -> entry.
function metricFromType(t) {
  t = String(t || '');
  if (t === 'top-ff' || t === 'top-ff-medic') return 'top';
  if (t === 'hourly-base') return 'skip';
  return 'entry';
}
// midpoint and reportedEntry/reportedMidpoint/reportedTop (a submission tagged
// "Reported total compensation") each stay on their own track from entry/top —
// never merged into base pay — so derive.js can keep them out of
// entry/topBase-based comparisons.
function toReport(fields) {
  const pv = (fields.proposedValues && fields.proposedValues.mapValue && fields.proposedValues.mapValue.fields) || {};
  const amount = money(fv(pv.amount));
  let entry = money(fv(pv.entry));
  let top = money(fv(pv.top));
  const midpoint = money(fv(pv.midpoint));
  const reportedEntry = money(fv(pv.reportedEntry));
  const reportedTop = money(fv(pv.reportedTop));
  const reportedMidpoint = money(fv(pv.reportedMidpoint));
  const metric = metricFromType(fv(pv.salaryType));
  if (entry == null && metric === 'entry') entry = amount;
  if (top == null && metric === 'top') top = amount;
  if (entry == null && top == null && midpoint == null && reportedEntry == null && reportedTop == null && reportedMidpoint == null) return null;
  return {
    contributorId: fv(fields.contributorId) || null,
    submittedAt: isoDay(fields.submittedAt && fields.submittedAt.timestampValue) || isoDay(Date.now()),
    entry,
    top,
    midpoint,
    reportedEntry,
    reportedTop,
    reportedMidpoint,
    hasSource: !!(fv(fields.sourceUrl) || fv(fields.sourceFile)),
    departmentMaintained: fv(fields.contributorType) === 'department'
  };
}

// A "This looks correct" confirmation is treated as an ordinary report agreeing
// with whatever figure(s) were showing at confirmation time — it joins the same
// cluster-input pool a real submission would, so it actually strengthens
// confidence and counts toward "Contributors confirming" instead of being
// written to Firestore and never read by anything (as it was before this).
function confirmationToReport(fields) {
  const entry = money(fv(fields.confirmedEntry));
  const top = money(fv(fields.confirmedTop));
  const midpoint = money(fv(fields.confirmedMidpoint));
  if (entry == null && top == null && midpoint == null) return null;
  return {
    contributorId: fv(fields.contributorId) || null,
    submittedAt: isoDay(fields.createdAt && fields.createdAt.timestampValue) || isoDay(Date.now()),
    entry, top, midpoint,
    hasSource: false,
    departmentMaintained: false
  };
}

// A flag doesn't erase a figure the instant someone disputes it — it stays
// showing, marked disputed, until enough DISTINCT contributors dispute that
// SAME exact value (mirrors extractStepPlans()'s threshold, same constant).
// Keyed by department+field+value (not a submission ID, since the entry/top/
// midpoint "current" figure is a consensus cluster of possibly many
// submissions, not one). Suppresses only the specific field that hit the
// threshold on each report — a report's other fields (e.g. its own top pay,
// if the dispute was against entry) are left untouched.
function applyValueDisputes(reports, slug, disputeCounts, threshold) {
  threshold = threshold == null ? DISPUTE_REVERT_THRESHOLD : threshold;
  return reports.map(r => {
    const out = Object.assign({}, r);
    ['entry', 'midpoint', 'top'].forEach(field => {
      if (out[field] == null) return;
      const count = disputeCounts.get(`${slug}|${field}|${out[field]}`) || 0;
      if (count >= threshold) out[field] = null;
      else if (count > 0) out[field + 'DisputeCount'] = count;
    });
    return out;
  });
}

// Generic Firestore REST value decoder — unlike fv() (scalars only), this also
// unwraps arrayValue/mapValue so a full step-plan submission's whole nested
// `proposedValues.steps` array and `plan` object can be recovered, not just the
// flat scalar fields toReport() extracts.
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    Object.keys(f).forEach(k => { out[k] = decodeValue(f[k]); });
    return out;
  }
  return undefined;
}

// A full step-plan submission's entry/top/midpoint headline figures already
// feed the numeric consensus via toReport() — but the actual step-by-step table
// itself was otherwise discarded, so a department page never showed a
// contributor's real pay steps, only ever the owner's seed data (if any).
// "Most recent submission wins" per department — no cross-plan clustering yet;
// that's a known v1 limitation, tracked separately from the (unaffected) numeric
// entry/top/midpoint consensus above.
// The `document.name` REST field is always the full resource path
// (.../documents/submissions/{docId}) — the last segment is the doc ID.
function docId(doc) {
  const name = doc && doc.name;
  if (!name) return null;
  const parts = String(name).split('/');
  return parts[parts.length - 1] || null;
}

// A flagged plan doesn't disappear on the first flag — it keeps showing, marked
// disputed, until enough DISTINCT contributors have flagged it (default 3; see
// DISPUTE_REVERT_THRESHOLD). Only then does it revert to the next most recent
// plan below the threshold. This is the safety net for a single bad/mistaken
// flag erasing good data, while still giving disputes real teeth once several
// people independently agree something is wrong — no admin approval needed
// either way, matching how every other automatic-promotion path here works.
const DISPUTE_REVERT_THRESHOLD = 3;

function extractStepPlans(rows, disputeCounts, threshold) {
  disputeCounts = disputeCounts || new Map();
  threshold = threshold == null ? DISPUTE_REVERT_THRESHOLD : threshold;
  const bySlug = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    if (fv(f.mode) !== 'plan') return;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const pv = decodeValue(f.proposedValues) || {};
    const rawSteps = Array.isArray(pv.steps) ? pv.steps.filter(s => s && s.basePay != null && s.label) : [];
    if (!rawSteps.length) return;
    const plan = decodeValue(f.plan) || {};
    (bySlug[slug] = bySlug[slug] || []).push({
      id: docId(r.document),
      submittedAt: isoDay(f.submittedAt && f.submittedAt.timestampValue) || isoDay(Date.now()),
      steps: rawSteps.map((s, i) => ({
        stepName: s.label,
        minimumMonths: s.startMonths,
        maximumMonths: i < rawSteps.length - 1 ? rawSteps[i + 1].startMonths : null,
        baseAnnualSalary: s.basePay,
        scheduledOvertime: s.scheduledOvertime != null ? s.scheduledOvertime : undefined
      })),
      classification: plan.classification || undefined,
      effectiveDate: plan.effectiveDate || undefined,
      sourceType: fv(f.sourceType) || undefined,
      sourceUrl: fv(f.sourceUrl) || undefined,
      contributorId: fv(f.contributorId) || null
    });
  });
  const plans = {};
  Object.keys(bySlug).forEach(slug => {
    const sorted = bySlug[slug].slice().sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0));
    const countOf = p => (p.id && disputeCounts.get(p.id)) || 0;
    const chosen = sorted.find(p => countOf(p) < threshold); // first one that hasn't hit the revert threshold
    if (chosen) {
      const count = countOf(chosen);
      plans[slug] = Object.assign({}, chosen, { disputeCount: count, disputed: count > 0 });
    }
  });
  return plans;
}

// Counts DISTINCT contributors who've flagged each step-plan submission (so one
// person spamming the flag button repeatedly can't reach the threshold alone).
// Public-read per firestore.rules (disputes: allow read: if true), no auth needed.
async function countStepPlanDisputes(baseUrl) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'disputes' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'field' }, op: 'EQUAL', value: { stringValue: 'stepPlan' } } },
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'open' } } }
          ]
        }
      }
    }
  };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  const flaggers = {}; // submissionId -> Set(contributorId)
  (Array.isArray(rows) ? rows : []).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const id = fv(r.document.fields.disputedSubmissionId);
    if (!id) return;
    const flagger = fv(r.document.fields.contributorId) || Math.random(); // anonymous flags each still count once
    (flaggers[id] = flaggers[id] || new Set()).add(flagger);
  });
  const counts = new Map();
  Object.keys(flaggers).forEach(id => counts.set(id, flaggers[id].size));
  return counts;
}

// Counts distinct contributors disputing each (department, field, value) triple
// for the numeric entry/midpoint/top figures — same dedup-by-contributor idea as
// countStepPlanDisputes, just keyed by value instead of a submission ID.
async function countValueDisputes(baseUrl) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'disputes' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'field' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'entry' }, { stringValue: 'midpoint' }, { stringValue: 'top' }] } } } },
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'open' } } }
          ]
        }
      }
    }
  };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  const flaggers = {}; // "slug|field|value" -> Set(contributorId)
  (Array.isArray(rows) ? rows : []).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug), field = fv(f.field), value = fv(f.disputedValue);
    if (!slug || !field || value == null) return;
    const key = `${slug}|${field}|${value}`;
    const flagger = fv(f.contributorId) || Math.random();
    (flaggers[key] = flaggers[key] || new Set()).add(flagger);
  });
  const counts = new Map();
  Object.keys(flaggers).forEach(key => counts.set(key, flaggers[key].size));
  return counts;
}

// Public-read per firestore.rules (confirmations: allow read: if true).
async function queryAllConfirmations(baseUrl) {
  const body = { structuredQuery: { from: [{ collectionId: 'confirmations' }] } };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  return Array.isArray(rows) ? rows : [];
}

// One "This looks correct" per contributor per department counts, no matter how
// many times they click it (the button only disables for the current page
// view, not permanently — reloading resets it). Keeps each contributor's MOST
// RECENT confirmation per department and drops the rest, so a repeat click
// can't inflate "Matching submissions" the way disputes were already protected
// from repeat flags (countStepPlanDisputes/countValueDisputes dedupe the same
// way, just via a Set instead of "keep the latest").
function dedupeConfirmations(rows) {
  const latest = {}; // "slug|contributorId" -> row
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    const contributorId = fv(f.contributorId);
    if (!slug || !contributorId) return;
    const key = `${slug}|${contributorId}`;
    const at = (f.createdAt && f.createdAt.timestampValue) || '';
    const existingAt = latest[key] ? ((latest[key].document.fields.createdAt && latest[key].document.fields.createdAt.timestampValue) || '') : null;
    if (existingAt == null || at > existingAt) latest[key] = r;
  });
  return Object.values(latest);
}

async function queryPublished(baseUrl, collectionId) {
  const body = { structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } } } } };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  return Array.isArray(rows) ? rows : [];
}

// ── New-department auto-promotion ───────────────────────────────────────────
// Turns a published `department_requests` doc into a full department record —
// geocoded from its ZIP centroid — so it shows up on the map/directory with no
// admin action. A request that looks like a likely duplicate, or whose ZIP
// doesn't resolve to a Texas centroid, is left un-promoted (still visible to an
// admin in Firestore) rather than risk a bad or duplicate map pin.
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fire department|fire rescue|department|dept|fd|esd|no|number)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}
function isDuplicate(name, city, existing) {
  const n = normName(name), c = String(city || '').toLowerCase().trim();
  if (!n || !c) return false;
  return existing.some(d => {
    if (String(d.city || '').toLowerCase().trim() !== c) return false;
    const dn = normName(d.name);
    return dn === n || dn.indexOf(n) !== -1 || n.indexOf(dn) !== -1;
  });
}
// Prefer a county the seed already maps to a region; fall back to a rough
// geographic bucket so a brand-new county still lands somewhere sane.
function makeRegionResolver(seedDepts) {
  const byCounty = {};
  (seedDepts || []).forEach(d => { if (d.county && !byCounty[d.county]) byCounty[d.county] = d.region; });
  return function inferRegion(county, lat, lng) {
    if (county && byCounty[county]) return byCounty[county];
    if (lat >= 34) return 'panhandle';
    if (lng <= -101.5) return 'west-texas';
    if (lat <= 27.5) return 'south-texas';
    if (lng >= -95.6 && lat <= 30.6) return 'gulf-coast';
    if (lng >= -95.8 && lat > 30.6) return 'east-texas';
    if (lat <= 30.9 && lng <= -96.8 && lng >= -99.5) return 'central-texas';
    return 'north-texas';
  };
}
function promoteDepartments(rows, seedDepts, zips) {
  const inferRegion = makeRegionResolver(seedDepts);
  const existing = (seedDepts || []).slice();
  const usedSlugs = new Set(existing.map(d => d.slug));
  const departments = [];
  let skippedDup = 0, skippedNoZip = 0;
  // Deterministic order (earliest submission first) so re-runs produce the same
  // result and, if two people request the same place, the first one wins.
  rows.slice().sort((a, b) => {
    const ta = (a.document && a.document.fields.submittedAt && a.document.fields.submittedAt.timestampValue) || '';
    const tb = (b.document && b.document.fields.submittedAt && b.document.fields.submittedAt.timestampValue) || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const name = fv(f.name), city = fv(f.city);
    if (!name || !city) return;
    if (isDuplicate(name, city, existing)) { skippedDup++; return; }
    const zip = String(fv(f.zip) || '').trim();
    const centroid = /^\d{5}$/.test(zip) ? zips[zip] : null;
    if (!centroid) { skippedNoZip++; return; }
    let slug = slugify(name); if (!slug) return;
    let unique = slug, i = 2;
    while (usedSlugs.has(unique)) { unique = slug + '-' + i; i++; }
    slug = unique; usedSlugs.add(slug);
    const county = fv(f.county) || '';
    const dept = {
      slug, name, city, county,
      region: inferRegion(county, centroid[0], centroid[1]),
      zip, lat: centroid[0], lng: centroid[1],
      departmentType: fv(f.departmentType) || 'other',
      website: fv(f.website) || '', careersUrl: '', phone: '',
      hiringStatus: 'unknown', transportStatus: 'unknown',
      scheduleType: '', annualScheduledHours: null,
      flags: { paramedicIncentive: false, certPay: false, educationPay: false, longevity: false, lateralsAccepted: false, emtRequired: false, paramedicRequired: false },
      dataStatus: 'none',
      communityAdded: true,
      addedAt: isoDay(f.submittedAt && f.submittedAt.timestampValue) || isoDay(Date.now())
    };
    departments.push(dept);
    existing.push(dept); // so a later duplicate request in this same batch is caught too
  });
  return { departments, skippedDup, skippedNoZip };
}

async function main() {
  const { projectId, apiKey } = readConfig();
  if (!projectId || !apiKey || apiKey === 'REPLACE_ME') {
    console.log('[export-overlay] Firebase not configured in firebase-init.js; leaving overlay.json unchanged.');
    return;
  }
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

  const subRows = await queryPublished(url, 'submissions');
  const reports = {};
  let n = 0;
  subRows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const rep = toReport(f);
    if (!rep) return;
    (reports[slug] = reports[slug] || []).push(rep);
    n++;
  });

  // Confirmations join the same report pool as real submissions (see
  // confirmationToReport) — an isolated failure here just means confirmations
  // don't count this run, not that the whole export fails.
  let confirmedCount = 0;
  try {
    const confRows = dedupeConfirmations(await queryAllConfirmations(url));
    confRows.forEach(r => {
      if (!r.document || !r.document.fields) return;
      const f = r.document.fields;
      const slug = fv(f.departmentSlug);
      if (!slug) return;
      const rep = confirmationToReport(f);
      if (!rep) return;
      (reports[slug] = reports[slug] || []).push(rep);
      confirmedCount++;
    });
  } catch (e) {
    console.warn('[export-overlay] confirmation lookup failed (treating none as confirmed):', e.message);
  }

  // A flag doesn't erase a figure on its own — it stays showing, marked
  // disputed, until enough distinct contributors dispute that same value (see
  // applyValueDisputes). An isolated lookup failure just means nothing is
  // suppressed this run.
  try {
    const valueDisputeCounts = await countValueDisputes(url);
    Object.keys(reports).forEach(slug => {
      reports[slug] = applyValueDisputes(reports[slug], slug, valueDisputeCounts);
    });
  } catch (e) {
    console.warn('[export-overlay] entry/top/midpoint dispute lookup failed (treating none as disputed):', e.message);
  }

  // A flag lookup failure must not block every plan from showing — it just
  // means dispute counts are treated as zero this run, not that step plans
  // stop working entirely.
  let stepPlanDisputeCounts = new Map();
  try {
    stepPlanDisputeCounts = await countStepPlanDisputes(url);
  } catch (e) {
    console.warn('[export-overlay] step-plan dispute lookup failed (treating none as flagged):', e.message);
  }
  const stepPlans = extractStepPlans(subRows, stepPlanDisputeCounts);

  // New departments: geocode from ZIP + auto-promote. Failures here (bad seed
  // read, missing ZIP table, Firestore hiccup) must not block the salary-report
  // overlay above, so they're isolated and just logged.
  let departments = [], skippedDup = 0, skippedNoZip = 0;
  try {
    const seedJson = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    const zips = readZipCentroids();
    const reqRows = await queryPublished(url, 'department_requests');
    const promoted = promoteDepartments(reqRows, seedJson.departments || [], zips);
    departments = promoted.departments; skippedDup = promoted.skippedDup; skippedNoZip = promoted.skippedNoZip;
  } catch (e) {
    console.warn('[export-overlay] department auto-promotion skipped:', e.message);
  }

  const out = {
    generated: new Date().toISOString(),
    note: 'Auto-generated by scripts/export-overlay.js from published Firestore submissions (public read; no credentials).',
    reports,
    departments,
    stepPlans
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Exported ${n} community report(s) + ${confirmedCount} confirmation(s) across ${Object.keys(reports).length} department(s) -> data/overlay.json`);
  console.log(`Promoted ${departments.length} new department(s) to the map` +
    (skippedDup ? `, skipped ${skippedDup} possible duplicate(s)` : '') +
    (skippedNoZip ? `, skipped ${skippedNoZip} with a missing/unrecognized ZIP` : '') + '.');
  const disputedCount = Object.values(stepPlans).filter(p => p.disputed).length;
  const revertedCount = Array.from(stepPlanDisputeCounts.values()).filter(c => c >= DISPUTE_REVERT_THRESHOLD).length;
  console.log(`Full step plans: ${Object.keys(stepPlans).length} department(s) now showing a live community-submitted pay-step table` +
    (disputedCount ? `, ${disputedCount} currently disputed` : '') +
    (revertedCount ? `, ${revertedCount} reverted past the ${DISPUTE_REVERT_THRESHOLD}-flag threshold` : '') + '.');
}

if (require.main === module) {
  main().catch(e => { console.error('[export-overlay] failed (keeping existing overlay.json):', e.message); process.exit(0); });
} else {
  module.exports = { slugify, normName, isDuplicate, makeRegionResolver, promoteDepartments, readZipCentroids, toReport, decodeValue, extractStepPlans, docId, DISPUTE_REVERT_THRESHOLD, confirmationToReport, applyValueDisputes, dedupeConfirmations };
}
