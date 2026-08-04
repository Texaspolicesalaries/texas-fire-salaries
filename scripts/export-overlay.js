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
function toReport(fields) {
  const pv = (fields.proposedValues && fields.proposedValues.mapValue && fields.proposedValues.mapValue.fields) || {};
  const amount = money(fv(pv.amount));
  let entry = money(fv(pv.entry));
  let top = money(fv(pv.top));
  const metric = metricFromType(fv(pv.salaryType));
  if (entry == null && metric === 'entry') entry = amount;
  if (top == null && metric === 'top') top = amount;
  if (entry == null && top == null) return null;
  return {
    contributorId: fv(fields.contributorId) || null,
    submittedAt: isoDay(fields.submittedAt && fields.submittedAt.timestampValue) || isoDay(Date.now()),
    entry,
    top,
    hasSource: !!(fv(fields.sourceUrl) || fv(fields.sourceFile)),
    departmentMaintained: fv(fields.contributorType) === 'department'
  };
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
    departments
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Exported ${n} community report(s) across ${Object.keys(reports).length} department(s) -> data/overlay.json`);
  console.log(`Promoted ${departments.length} new department(s) to the map` +
    (skippedDup ? `, skipped ${skippedDup} possible duplicate(s)` : '') +
    (skippedNoZip ? `, skipped ${skippedNoZip} with a missing/unrecognized ZIP` : '') + '.');
}

if (require.main === module) {
  main().catch(e => { console.error('[export-overlay] failed (keeping existing overlay.json):', e.message); process.exit(0); });
} else {
  module.exports = { slugify, normName, isDuplicate, makeRegionResolver, promoteDepartments, readZipCentroids };
}
