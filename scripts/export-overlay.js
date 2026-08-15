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

// safeUrl is the last chokepoint before a community-submitted link becomes a
// live href on the static site. submit.js validates too, but this runs over
// every document including ones written before that validation existed, and
// Firestore rules don't constrain URL shape at all.
const { safeUrl } = require('../js/salary-lib.js');
// The same tolerance the consensus engine clusters with — disputes have to be
// matched the way values are grouped, not by exact equality. See disputeCountFor.
const { valuesMatch } = require('../js/consensus.js');

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
  // Recruit/academy pay — a flat, pre-graduation figure kept on its own track,
  // same idea as midpoint: never merged into entry/top so a department's
  // academy stipend can't get mistaken for its Firefighter entry pay. See
  // js/submit.js's Position: Recruit routing and data/schema.md.
  const recruit = money(fv(pv.recruit));
  const reportedEntry = money(fv(pv.reportedEntry));
  const reportedTop = money(fv(pv.reportedTop));
  const reportedMidpoint = money(fv(pv.reportedMidpoint));
  const metric = metricFromType(fv(pv.salaryType));
  if (entry == null && metric === 'entry') entry = amount;
  if (top == null && metric === 'top') top = amount;
  // A submission carrying only supplemental pay items (no entry/top/midpoint
  // figure at all) is still real data — e.g. someone adding "Longevity pay"
  // to a department that already has its base pay on file — so it must not
  // be dropped just because none of the six base/reported figures are set.
  const supplemental = decodeValue(pv.supplemental) || undefined;
  // Working conditions travel with the report so the history timeline can say
  // what a revision actually changed. Without them a contributor who corrected
  // a department's shift schedule saw their submission publish and appear
  // nowhere — the figures were identical, so the card listed no changes at all.
  const plan = decodeValue(fields.plan) || {};
  const schedule = plan.schedule || fv(pv.schedule) || undefined;
  const hoursRaw = plan.hoursAnnual != null ? plan.hoursAnnual : fv(pv.hoursAnnual);
  const hoursAnnual = hoursRaw == null || hoursRaw === '' ? undefined : Number(hoursRaw);
  // The effective date the form REQUIRES alongside any pay figure. It was
  // collected, validated, and stored faithfully — and then dropped right here,
  // so a department went on showing its seed effective date no matter how many
  // current figures arrived. Plan mode carries it on `plan`, every other mode on
  // `proposedValues`; both are read so the submission's mode doesn't matter.
  const effectiveDate = plan.effectiveDate || fv(pv.effectiveDate) || undefined;
  // A submission that changes ONLY working conditions — or only says when the
  // figures already on file took effect — is still a real contribution;
  // returning null here dropped it entirely. An effective-date-only report
  // carries no figure, so it never joins a consensus cluster or counts toward
  // the contributor total; it exists so derive.js can pick the date up and the
  // history timeline can show who supplied it.
  if (entry == null && top == null && midpoint == null && recruit == null && reportedEntry == null && reportedTop == null && reportedMidpoint == null
      && !(supplemental && supplemental.length) && !schedule && !(hoursAnnual > 0) && !effectiveDate) return null;
  return {
    contributorId: fv(fields.contributorId) || null,
    submittedAt: isoDay(fields.submittedAt && fields.submittedAt.timestampValue) || isoDay(Date.now()),
    entry,
    top,
    midpoint,
    recruit,
    reportedEntry,
    reportedTop,
    reportedMidpoint,
    supplemental,
    schedule,
    hoursAnnual,
    effectiveDate,
    // The LINK itself, not just the fact that one exists. Keeping only the
    // boolean meant a contributor could paste their department's official pay
    // page and the site would still render "Source supplied: No" — the evidence
    // that makes a figure trustworthy was collected, stored in Firestore, and
    // then dropped one hop before display. safeUrl gates it because these become
    // live hrefs; a rejected scheme leaves hasSource false rather than
    // advertising a source nobody can open.
    sourceUrl: safeUrl(fv(fields.sourceUrl)) || undefined,
    sourceFile: safeUrl(fv(fields.sourceFile)) || undefined,
    sourceType: fv(fields.sourceType) || undefined,
    // base-ot means the figure already has scheduled overtime folded in. Without
    // this the amount lands in `entry` indistinguishable from pure base pay —
    // exactly the blending this project refuses to do elsewhere.
    includesScheduledOvertime: fv((fields.proposedValues && fields.proposedValues.mapValue
      && fields.proposedValues.mapValue.fields || {}).basis) === 'base-ot' || undefined,
    hasSource: !!(safeUrl(fv(fields.sourceUrl)) || safeUrl(fv(fields.sourceFile))),
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
    // Marks this as a "This looks correct" click rather than a reported figure.
    // It joins the consensus pool either way, but js/department.js's revision
    // timeline must not diff it against the report before it: a confirmation
    // carries the figures DISPLAYED at the time, so diffing produced phantom
    // revisions — "Added top pay $90,000", credited to someone who only clicked
    // a button and reported nothing.
    confirmation: true,
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
// How many DISTINCT contributors have disputed a value that belongs to the same
// consensus cluster as `value`.
//
// Matching by the clustering tolerance rather than by exact equality is what
// makes a dispute work at all on a figure backed by more than one report. The
// page displays the cluster MEAN (js/consensus.js's clusterValues), so the
// number a visitor sees — and therefore the number js/department.js records as
// `disputedValue` — is routinely a number no individual report holds: two
// reports of $60,000 and $60,500 display as $60,250. Keyed on exact equality,
// any number of people disputing that displayed figure suppressed nothing at
// all, silently, which made the whole "report incorrect information" path
// inoperative on exactly the departments with the most reports behind them.
//
// Flagger sets are unioned rather than counts summed, so one person disputing
// both $60,000 and $60,500 still counts once toward the revert threshold.
function disputeCountFor(disputes, slug, field, value) {
  if (value == null || !disputes) return 0;
  const entries = disputes.get(`${slug}|${field}`);
  if (!entries) return 0;
  const flaggers = new Set();
  entries.forEach(e => {
    if (!valuesMatch(e.value, value)) return;
    e.flaggers.forEach(f => flaggers.add(f));
  });
  return flaggers.size;
}

function applyValueDisputes(reports, slug, disputes, threshold) {
  threshold = threshold == null ? DISPUTE_REVERT_THRESHOLD : threshold;
  return reports.map(r => {
    const out = Object.assign({}, r);
    ['entry', 'midpoint', 'top', 'recruit'].forEach(field => {
      if (out[field] == null) return;
      const count = disputeCountFor(disputes, slug, field, out[field]);
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

// The step table carried by ONE plan-mode document, in seed `salary.steps`
// shape — or null if this document isn't a usable plan. Shared by
// extractStepPlans (ordinary `submissions`) and promoteDepartments
// (`department_requests`, where a brand-new department can arrive with its
// whole pay plan attached), so both paths build steps identically.
function stepPlanFromDoc(doc) {
  const f = (doc && doc.fields) || null;
  if (!f) return null;
  if (fv(f.mode) !== 'plan') return null;
  const pv = decodeValue(f.proposedValues) || {};
  const rawSteps = Array.isArray(pv.steps) ? pv.steps.filter(s => s && s.basePay != null && s.label) : [];
  if (!rawSteps.length) return null;
  const plan = decodeValue(f.plan) || {};
  return {
    id: docId(doc),
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
    // Free-text context the contributor typed ("steps from the 2026 approved
    // pay scale"). The form asks for it, so it has to survive to the page.
    notes: plan.notes || undefined,
    sourceType: fv(f.sourceType) || undefined,
    sourceUrl: safeUrl(fv(f.sourceUrl)) || undefined,
    contributorId: fv(f.contributorId) || null
  };
}

function extractStepPlans(rows, disputeCounts, threshold) {
  disputeCounts = disputeCounts || new Map();
  threshold = threshold == null ? DISPUTE_REVERT_THRESHOLD : threshold;
  const bySlug = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const slug = fv(r.document.fields.departmentSlug);
    if (!slug) return;
    const plan = stepPlanFromDoc(r.document);
    if (!plan) return;
    (bySlug[slug] = bySlug[slug] || []).push(plan);
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

// A department-level fact (not a pay figure) that a contributor can optionally
// assert alongside their salary submission — see js/submit.js's "Department
// facts" section. Most recent assertion per department wins, no dispute
// mechanism (unlike step plans/pay figures) since it's a simple yes/no fact,
// not a contested number. A submission that leaves it "Not sure" simply omits
// the field, so it never overwrites a known answer with a guess.
function extractCivilService(rows) {
  const bySlug = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const raw = fv(f.civilService);
    if (raw !== true && raw !== false) return;
    const submittedAt = isoDay(f.submittedAt && f.submittedAt.timestampValue) || isoDay(Date.now());
    const cur = bySlug[slug];
    if (!cur || submittedAt >= cur.submittedAt) bySlug[slug] = { value: raw, submittedAt };
  });
  const out = {};
  Object.keys(bySlug).forEach(slug => { out[slug] = bySlug[slug].value; });
  return out;
}

// Shift schedule and scheduled annual hours, same most-recent-wins treatment as
// extractCivilService. These are department-level working conditions, not pay
// figures, so they don't cluster — but they were previously collected by the
// form and then dropped on the floor: toReport() only ever extracted pay, so a
// contributor who corrected only a department's schedule watched their
// submission publish and change nothing. Hours also feed effective-hourly math,
// which is the whole point of comparing a 2,912-hour shift job to a 2,080-hour
// one, so silently discarding them skewed a headline number.
//
// A plan-mode submission carries these on `plan`, the other modes on
// `proposedValues`; both are read so the source mode doesn't matter.
function extractDeptFacts(rows) {
  const bySlug = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const pv = decodeValue(f.proposedValues) || {};
    const plan = decodeValue(f.plan) || {};
    const schedule = plan.schedule || pv.schedule || null;
    const hoursRaw = plan.hoursAnnual != null ? plan.hoursAnnual : pv.hoursAnnual;
    const hours = hoursRaw == null ? null : Number(hoursRaw);
    if (!schedule && !(hours > 0)) return;
    const submittedAt = isoDay(f.submittedAt && f.submittedAt.timestampValue) || isoDay(Date.now());
    const cur = bySlug[slug];
    if (cur && submittedAt < cur.submittedAt) return;
    // Merge rather than replace: a submission that set only a schedule must not
    // erase a more complete earlier one's hours.
    const next = Object.assign({}, cur && cur.value);
    if (schedule) next.scheduleType = String(schedule);
    if (hours > 0) next.annualScheduledHours = hours;
    bySlug[slug] = { value: next, submittedAt };
  });
  const out = {};
  Object.keys(bySlug).forEach(slug => { out[slug] = bySlug[slug].value; });
  return out;
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
            { fieldFilter: { field: { fieldPath: 'field' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'entry' }, { stringValue: 'midpoint' }, { stringValue: 'top' }, { stringValue: 'recruit' }] } } } },
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
  // "slug|field" -> [{ value, flaggers:Set }], one entry per distinct disputed
  // value. Grouped by field rather than by exact value so disputeCountFor() can
  // gather every dispute that falls inside a report's consensus cluster.
  const byField = new Map();
  (Array.isArray(rows) ? rows : []).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug), field = fv(f.field), raw = fv(f.disputedValue);
    if (!slug || !field || raw == null) return;
    const value = money(raw);
    if (value == null) return;
    const key = `${slug}|${field}`;
    const entries = byField.get(key) || [];
    let entry = entries.find(e => e.value === value);
    if (!entry) { entry = { value, flaggers: new Set() }; entries.push(entry); }
    entry.flaggers.add(fv(f.contributorId) || Math.random()); // anonymous flags each still count once
    byField.set(key, entries);
  });
  return byField;
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

// ── Admin tools (js/admin.js) — name/coordinate corrections, duplicate merges,
// standing field locks, one-time value corrections, and contributor
// suspensions. All four collections are public-read per firestore.rules
// (small, admin-authored, non-PII documents) specifically so this
// credential-free export can pick them up — see each collection's rules
// comment for why that's an acceptable trade vs. the alternative of needing
// a service account.

// department_overrides/{slug} — an admin's correction to a department's
// display name or map coordinates, or a mark that it's a duplicate which
// should redirect to another department's page. Doc ID is the slug, but this
// reads the departmentSlug FIELD (not the REST resource name) so it still
// works if that convention ever changes.
function extractDeptOverrides(rows) {
  const out = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const entry = {};
    const name = fv(f.name); if (name) entry.name = name;
    const lat = fv(f.lat); if (lat != null) entry.lat = Number(lat);
    const lng = fv(f.lng); if (lng != null) entry.lng = Number(lng);
    const mergeIntoSlug = fv(f.mergeIntoSlug); if (mergeIntoSlug) entry.mergeIntoSlug = mergeIntoSlug;
    if (Object.keys(entry).length) out[slug] = entry;
  });
  return out;
}

// A duplicate department redirects to its merge target — Cloudflare Pages'
// native `_redirects` file (see scripts/build-site.js) handles the 301, so no
// client JS or extra page weight is needed. Self-referencing entries (a typo
// that points a slug at itself) are dropped rather than trusted, since that
// would otherwise redirect a page to itself.
function computeMergedRedirects(overrides) {
  const out = [];
  Object.keys(overrides || {}).forEach(slug => {
    const to = overrides[slug] && overrides[slug].mergeIntoSlug;
    if (to && to !== slug) out.push({ from: slug, to });
  });
  return out;
}

// field_locks/{slug}__{field} — an admin pins entry/top/midpoint to a fixed,
// verified value. js/derive.js applies this AFTER consensus so it can't be
// out-voted by any number of later community submissions. `active` defaults
// to true (locked) when absent; an admin "unlocks" by setting active:false on
// the same doc rather than deleting it, preserving the record of what was
// corrected and why.
function extractFieldLocks(rows) {
  const out = {};
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug), field = fv(f.field);
    if (!slug || !field || ['entry', 'top', 'midpoint'].indexOf(field) === -1) return;
    if (fv(f.active) === false) return;
    const value = money(fv(f.value));
    if (value == null) return;
    (out[slug] = out[slug] || {})[field] = { value, locked: true, note: fv(f.note) || undefined };
  });
  return out;
}

// admin_corrections — a one-time, non-standing correction: it joins the
// SAME report pool a real submission would (see scripts/export-overlay.js's
// applyOverlay via the `reports` map in main()), so it wins the way any fresh,
// recent report would under ordinary consensus rather than being permanently
// pinned — a later flood of genuine community reports can still naturally
// supersede it over time. Use a field_lock instead when the value needs to
// stay fixed regardless of what comes in later.
function adminCorrectionToReport(fields) {
  const slug = fv(fields.departmentSlug);
  const field = fv(fields.field);
  const value = money(fv(fields.value));
  if (!slug || !field || value == null || ['entry', 'top', 'midpoint'].indexOf(field) === -1) return null;
  const report = {
    // overlay.json is public, so the admin's email must not ride along as the
    // contributorId. A short one-way hash keeps corrections from different
    // admin accounts distinct (for contributor counting) without exposing
    // who; the full email stays in the admin-only Firestore doc's createdBy.
    contributorId: 'admin:' + require('crypto').createHash('sha1')
      .update(String(fv(fields.createdBy) || 'unknown')).digest('hex').slice(0, 8),
    submittedAt: isoDay(fields.createdAt && fields.createdAt.timestampValue) || isoDay(Date.now()),
    hasSource: false,
    departmentMaintained: false,
    adminCorrection: true,
    note: fv(fields.note) || undefined
  };
  report[field] = value;
  return { slug, report };
}

// suspended_contributors/{userId} — a spam/abuse contributor whose input
// should stop counting, past and future alike (see js/aggregate.js's
// applySuspensions). Deliberately minimal (just a userId, no email/PII) so
// public-reading this small list to filter reports doesn't expose anything
// sensitive — matches how an approved department_claims doc is public-read
// while its email field stays admin/claimant-only.
function extractSuspendedContributors(rows) {
  const out = new Set();
  rows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const userId = fv(r.document.fields.userId);
    if (userId) out.add(userId);
  });
  return out;
}

// Generic "read an entire small public collection" — used for the admin-tool
// collections above, which are all tiny (dozens of docs at most) and never
// need a status filter the way submissions/department_requests do.
async function queryAllDocs(baseUrl, collectionId) {
  const body = { structuredQuery: { from: [{ collectionId }] } };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  return Array.isArray(rows) ? rows : [];
}

// Public-read only for status=='approved' per firestore.rules (an admin already
// vetted these — see js/admin.js's approval action) — no credentials needed.
async function queryApprovedClaims(baseUrl) {
  const body = { structuredQuery: { from: [{ collectionId: 'department_claims' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'approved' } } } } };
  const res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  if (rows && rows.error) throw new Error(rows.error.status + ' ' + rows.error.message);
  const claims = [];
  (Array.isArray(rows) ? rows : []).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const userId = fv(f.userId), slug = fv(f.departmentSlug);
    if (!userId || !slug) return;
    claims.push({
      id: docId(r.document),
      userId, departmentSlug: slug,
      resolvedAt: isoDay(f.resolvedAt && f.resolvedAt.timestampValue),
      createdAt: isoDay(f.createdAt && f.createdAt.timestampValue)
    });
  });
  return claims;
}

// A claim doesn't stay "Department maintained" forever just because it was
// once approved — a rep who claims a department and then goes quiet leaves a
// stale figure locked in ahead of any amount of fresh community agreement
// (selectCurrentCluster() in js/consensus.js gives a department-maintained
// cluster outright priority, with no recency comparison against community
// clusters at all). Expiring the claim itself after 18 months of inactivity —
// the same "possibly outdated" cutoff js/consensus.js already uses for the
// freshness label — closes that gap without inventing a second threshold:
// once expired, the badge disappears, the claim button reappears for someone
// else, AND (since departmentMaintained is recomputed fresh on every export
// run below, not trusted from whatever a submission's contributorType said
// months ago) that person's old reports stop auto-winning consensus too.
const CLAIM_EXPIRY_MONTHS = 18;
function computeActiveClaimants(claims, subRows, now, thresholdMonths) {
  thresholdMonths = thresholdMonths == null ? CLAIM_EXPIRY_MONTHS : thresholdMonths;
  const thresholdMs = thresholdMonths * 30.437 * 24 * 3600 * 1000;
  const lastActivity = new Map(); // "userId|slug" -> ms
  (subRows || []).forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const cid = fv(f.contributorId), slug = fv(f.departmentSlug);
    if (!cid || !slug) return;
    const t = Date.parse(f.submittedAt && f.submittedAt.timestampValue);
    if (isNaN(t)) return;
    const key = cid + '|' + slug;
    if (!lastActivity.has(key) || t > lastActivity.get(key)) lastActivity.set(key, t);
  });
  const active = new Set();
  (claims || []).forEach(c => {
    const key = c.userId + '|' + c.departmentSlug;
    // No submission yet since approval — give them the full window from
    // approval (or, lacking that, from when the claim was first made) rather
    // than treating a brand-new claimant as already stale.
    const baselineIso = lastActivity.has(key) ? null : (c.resolvedAt || c.createdAt);
    const baseline = lastActivity.has(key) ? lastActivity.get(key) : Date.parse(baselineIso);
    if (!isNaN(baseline) && (now - baseline) <= thresholdMs) active.add(key);
  });
  return active;
}

// A contributor becomes "trusted" once they've submitted enough data across
// enough different departments WITHOUT any of their individual dept/field/
// value submissions ever being disputed past the community-revert threshold
// (see applyValueDisputes/DISPUTE_REVERT_THRESHOLD) — a plain, defensible
// proxy for "this person's numbers have held up," not a popularity contest.
// A single bad dispute permanently disqualifies them from this run (they can
// requalify on a later run once their more-recent, undisputed reports clear
// the thresholds on their own — there's no separate appeal path, matching how
// every other automatic promotion here works with no admin approval step).
// Trusted contributors count DOUBLE toward "unique contributors" in
// js/consensus.js's clusterValues() (see js/derive.js's reportsForField) — a
// bounded boost, nowhere near department-maintained's outright override.
const MIN_TRUSTED_REPORTS = 3;
const MIN_TRUSTED_DEPARTMENTS = 2;
function computeTrustedContributors(subRows, disputes, opts) {
  opts = opts || {};
  disputes = disputes || new Map();
  const minReports = opts.minReports == null ? MIN_TRUSTED_REPORTS : opts.minReports;
  const minDepartments = opts.minDepartments == null ? MIN_TRUSTED_DEPARTMENTS : opts.minDepartments;
  const threshold = opts.disputeThreshold == null ? DISPUTE_REVERT_THRESHOLD : opts.disputeThreshold;
  const suspended = opts.suspendedIds || new Set();
  const byContributor = new Map(); // contributorId -> { depts:Set, reports:Number, disqualified:Boolean }
  subRows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const contributorId = fv(f.contributorId);
    const slug = fv(f.departmentSlug);
    if (!contributorId || !slug) return;
    const rep = toReport(f);
    if (!rep) return;
    const entry = byContributor.get(contributorId) || { depts: new Set(), reports: 0, disqualified: false };
    ['entry', 'top', 'midpoint', 'recruit'].forEach(field => {
      if (rep[field] == null) return;
      if (disputeCountFor(disputes, slug, field, rep[field]) >= threshold) entry.disqualified = true;
    });
    entry.depts.add(slug);
    entry.reports++;
    byContributor.set(contributorId, entry);
  });
  const trusted = new Set();
  byContributor.forEach((v, contributorId) => {
    if (suspended.has(contributorId)) return;
    if (!v.disqualified && v.reports >= minReports && v.depts.size >= minDepartments) trusted.add(contributorId);
  });
  return trusted;
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
  // A department_requests doc carries the SAME proposedValues/plan payload an
  // ordinary submission does (js/submit.js's gather() builds one shape for both
  // flows), but it has no departmentSlug — the slug doesn't exist until it's
  // minted right here. The reports/stepPlans pools in main() are keyed by slug
  // and skip anything without one, so unless this function hands the salary
  // back under the slug it just assigned, everything the contributor typed on
  // the "Add a new department" form is silently dropped and the department
  // lands on the map reading "Salary information needed".
  const reports = {};
  const stepPlans = {};
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
      website: safeUrl(fv(f.website)) || '', careersUrl: '', phone: '',
      hiringStatus: 'unknown', transportStatus: 'unknown',
      scheduleType: '', annualScheduledHours: null,
      flags: { paramedicIncentive: false, certPay: false, educationPay: false, longevity: false, lateralsAccepted: false, emtRequired: false, paramedicRequired: false },
      dataStatus: 'none',
      communityAdded: true,
      addedAt: isoDay(f.submittedAt && f.submittedAt.timestampValue) || isoDay(Date.now())
    };
    // Salary the requester attached on the same form, re-keyed to the slug just
    // minted above so main() can fold it into the normal report/step-plan pools.
    const rep = toReport(f);
    if (rep) reports[slug] = [rep];
    // Working conditions and the civil-service answer come in on the SAME form
    // as a new department's pay, but extractDeptFacts/extractCivilService only
    // scan `submissions` — and this record is a department_request, so
    // everything the founding contributor said about the department itself was
    // dropped and the page published with a blank schedule and no hours, which
    // also left its effective-hourly figures resting on the 2,912 assumption.
    if (rep && rep.schedule) dept.scheduleType = String(rep.schedule);
    if (rep && rep.hoursAnnual > 0) dept.annualScheduledHours = rep.hoursAnnual;
    const civil = fv(f.civilService);
    if (civil === true || civil === false) dept.civilService = civil;
    const plan = stepPlanFromDoc(r.document);
    if (plan) stepPlans[slug] = Object.assign({}, plan, { disputeCount: 0, disputed: false });
    // Only an actual pay figure flips this, matching scripts/import-sheet.js's
    // `steps ? 'current' : 'none'`. A supplemental-only request still attaches
    // its report above (those items drive the cert/education/longevity/medic
    // filter flags) but doesn't earn 'current' — there's no salary to show yet,
    // which is exactly what 'none' means.
    const PAY_FIELDS = ['entry', 'top', 'midpoint', 'recruit', 'reportedEntry', 'reportedTop', 'reportedMidpoint'];
    if (plan || (rep && PAY_FIELDS.some(k => rep[k] != null))) dept.dataStatus = 'current';
    departments.push(dept);
    existing.push(dept); // so a later duplicate request in this same batch is caught too
  });
  return { departments, reports, stepPlans, skippedDup, skippedNoZip };
}

async function main() {
  const { projectId, apiKey } = readConfig();
  if (!projectId || !apiKey || apiKey === 'REPLACE_ME') {
    console.log('[export-overlay] Firebase not configured in firebase-init.js; leaving overlay.json unchanged.');
    return;
  }
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

  const subRows = await queryPublished(url, 'submissions');

  // Recomputed fresh every run from the CURRENT claim state, not trusted from
  // whatever a submission's contributorType said at the time it was written —
  // see computeActiveClaimants() for why that matters (an expired claim must
  // stop winning consensus on its OLD reports too, not just lose the badge).
  let activeClaimants = new Set(), claims = [];
  try {
    claims = await queryApprovedClaims(url);
    activeClaimants = computeActiveClaimants(claims, subRows, Date.now());
  } catch (e) {
    console.warn('[export-overlay] department-claim lookup failed (treating none as claimed):', e.message);
  }
  const claimedSlugs = new Set(claims.filter(c => activeClaimants.has(c.userId + '|' + c.departmentSlug)).map(c => c.departmentSlug));

  const reports = {};
  let n = 0;
  subRows.forEach(r => {
    if (!r.document || !r.document.fields) return;
    const f = r.document.fields;
    const slug = fv(f.departmentSlug);
    if (!slug) return;
    const rep = toReport(f);
    if (!rep) return;
    rep.departmentMaintained = !!(rep.contributorId && activeClaimants.has(rep.contributorId + '|' + slug));
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
  // suppressed this run. Hoisted (not `const` inside the try) so
  // computeTrustedContributors below can reuse the same fetched counts rather
  // than querying disputes twice.
  let valueDisputes = new Map();
  try {
    valueDisputes = await countValueDisputes(url);
    Object.keys(reports).forEach(slug => {
      reports[slug] = applyValueDisputes(reports[slug], slug, valueDisputes);
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
  const civilService = extractCivilService(subRows);
  const deptFacts = extractDeptFacts(subRows);

  // Admin tools (js/admin.js) — name/coordinate corrections, duplicate-merge
  // redirects, standing field locks, one-time value corrections, and
  // contributor suspensions. Each is isolated so a lookup failure on any one
  // just leaves that tool's effect off this run, not the whole export.
  let departmentOverrides = {}, mergedRedirects = [];
  try {
    departmentOverrides = extractDeptOverrides(await queryAllDocs(url, 'department_overrides'));
    mergedRedirects = computeMergedRedirects(departmentOverrides);
  } catch (e) {
    console.warn('[export-overlay] department-override lookup failed (treating none as overridden):', e.message);
  }
  let fieldLocks = {};
  try {
    fieldLocks = extractFieldLocks(await queryAllDocs(url, 'field_locks'));
  } catch (e) {
    console.warn('[export-overlay] field-lock lookup failed (treating none as locked):', e.message);
  }
  let correctionCount = 0;
  try {
    (await queryAllDocs(url, 'admin_corrections')).forEach(r => {
      if (!r.document || !r.document.fields) return;
      const parsed = adminCorrectionToReport(r.document.fields);
      if (!parsed) return;
      (reports[parsed.slug] = reports[parsed.slug] || []).push(parsed.report);
      correctionCount++;
    });
  } catch (e) {
    console.warn('[export-overlay] admin-correction lookup failed (treating none as corrected):', e.message);
  }
  // Exported as a plain list, not filtered out of `reports` here — the actual
  // filtering happens once, at merge time, via js/aggregate.js's
  // applySuspensions (used by BOTH build-site.js and js/data.js), the same
  // single-application-point pattern as claimedSlugs/civilService/stepPlans.
  let suspendedContributorIds = [];
  try {
    suspendedContributorIds = Array.from(extractSuspendedContributors(await queryAllDocs(url, 'suspended_contributors')));
  } catch (e) {
    console.warn('[export-overlay] suspended-contributor lookup failed (treating none as suspended):', e.message);
  }

  // Trusted contributors get a bounded weight boost in consensus (see
  // js/consensus.js's clusterValues) — computed from the SAME submissions +
  // dispute counts already fetched above, so this costs zero extra reads.
  let trustedContributorIds = new Set();
  try {
    trustedContributorIds = computeTrustedContributors(subRows, valueDisputes, { suspendedIds: new Set(suspendedContributorIds) });
    Object.keys(reports).forEach(slug => {
      reports[slug].forEach(rep => { rep.trusted = !!(rep.contributorId && trustedContributorIds.has(rep.contributorId)); });
    });
  } catch (e) {
    console.warn('[export-overlay] trusted-contributor computation failed (treating none as trusted):', e.message);
  }

  // New departments: geocode from ZIP + auto-promote. Failures here (bad seed
  // read, missing ZIP table, Firestore hiccup) must not block the salary-report
  // overlay above, so they're isolated and just logged.
  let departments = [], skippedDup = 0, skippedNoZip = 0, promotedReportCount = 0;
  try {
    const seedJson = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    const zips = readZipCentroids();
    const reqRows = await queryPublished(url, 'department_requests');
    const promoted = promoteDepartments(reqRows, seedJson.departments || [], zips);
    departments = promoted.departments; skippedDup = promoted.skippedDup; skippedNoZip = promoted.skippedNoZip;
    // Salary that arrived on the "Add a new department" form, now keyed by the
    // slug promoteDepartments minted. These slugs are brand new by definition,
    // so nothing is overwritten — but merge rather than assign so a later
    // ordinary submission against the same department still wins/accumulates.
    Object.keys(promoted.reports).forEach(slug => {
      reports[slug] = (reports[slug] || []).concat(promoted.reports[slug]);
      promotedReportCount++;
    });
    Object.keys(promoted.stepPlans).forEach(slug => {
      if (!stepPlans[slug]) stepPlans[slug] = promoted.stepPlans[slug];
    });
  } catch (e) {
    console.warn('[export-overlay] department auto-promotion skipped:', e.message);
  }

  const out = {
    generated: new Date().toISOString(),
    note: 'Auto-generated by scripts/export-overlay.js from published Firestore submissions (public read; no credentials).',
    reports,
    departments,
    stepPlans,
    civilService,
    deptFacts,
    claimedSlugs: Array.from(claimedSlugs),
    departmentOverrides,
    fieldLocks,
    mergedRedirects,
    suspendedContributorIds
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Exported ${n} community report(s) + ${confirmedCount} confirmation(s) + ${correctionCount} admin correction(s) across ${Object.keys(reports).length} department(s) -> data/overlay.json`);
  console.log(`Civil service: ${Object.keys(civilService).length} department(s) with a submitted answer.`);
  console.log(`Department claims: ${claimedSlugs.size} department(s) marked "Department maintained".`);
  console.log(`Admin tools: ${Object.keys(departmentOverrides).length} department override(s) (${mergedRedirects.length} merged), ${Object.keys(fieldLocks).length} department(s) with a locked field, ${suspendedContributorIds.length} suspended contributor(s), ${trustedContributorIds.size} trusted contributor(s).`);
  console.log(`Promoted ${departments.length} new department(s) to the map` +
    (promotedReportCount ? `, ${promotedReportCount} arriving with salary data attached` : '') +
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
  module.exports = {
    slugify, normName, isDuplicate, makeRegionResolver, promoteDepartments, readZipCentroids, toReport, decodeValue,
    extractStepPlans, stepPlanFromDoc, extractCivilService, extractDeptFacts, docId, DISPUTE_REVERT_THRESHOLD, confirmationToReport, applyValueDisputes,
    dedupeConfirmations, computeActiveClaimants, CLAIM_EXPIRY_MONTHS,
    extractDeptOverrides, computeMergedRedirects, extractFieldLocks, adminCorrectionToReport,
    extractSuspendedContributors, computeTrustedContributors, MIN_TRUSTED_REPORTS, MIN_TRUSTED_DEPARTMENTS
  };
}
