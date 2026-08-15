#!/usr/bin/env node
/*
 * notify-queues.js — Tells the admin when the site needs them, using a GitHub
 * issue as the notification channel (GitHub's own email does the delivery, so
 * there are no mail secrets to configure and nothing new to break).
 *
 * Runs at the end of every refresh-and-deploy workflow pass (~every 5 min):
 *   - Reads Firestore over REST with only the public web key, same as
 *     scripts/export-overlay.js: flagged submissions, open disputes, and
 *     submissions published in the last RECENT_HOURS are all public-read.
 *     (Pending claims and new-department queues are admin-only by design, so
 *     this watcher cannot see them — the issue body says so.)
 *   - Maintains at most ONE open issue labeled `queue-alert`: created when
 *     something first needs review (that's the notification email), commented
 *     when NEW items appear (another email), body silently refreshed when
 *     items resolve or age out, closed when everything is clear.
 *   - State between runs lives in the issue body itself, as a JSON marker in
 *     an HTML comment — no artifact storage, no race with concurrent runs
 *     (the workflow's concurrency group serializes passes).
 *
 * Flagged/dispute/submission contents in the issue are already public data
 * (public-read collections rendered on the site); contributor ids/emails are
 * deliberately NOT included.
 *
 * Local check without touching GitHub:  node scripts/notify-queues.js --dry-run
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://texasfiresalaries.com';
const LABEL = 'queue-alert';
const RECENT_HOURS = 72;
const DRY = process.argv.includes('--dry-run');

// Single source of truth: pull projectId + apiKey out of firebase-init.js
// (same approach as export-overlay.js — the web key is public by design).
function readConfig() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'firebase-init.js'), 'utf8');
  const projectId = (src.match(/projectId:\s*["']([^"']+)["']/) || [])[1];
  const apiKey = (src.match(/apiKey:\s*["']([^"']+)["']/) || [])[1];
  if (!projectId || !apiKey) throw new Error('Could not read Firebase config from js/firebase-init.js');
  return { projectId, apiKey };
}

// Firestore REST wraps scalars as { stringValue | integerValue | ... }.
function fv(x) {
  if (!x) return undefined;
  if ('integerValue' in x) return Number(x.integerValue);
  if ('doubleValue' in x) return x.doubleValue;
  return x.stringValue ?? x.booleanValue ?? x.timestampValue ?? undefined;
}
function mapFields(x) { return (x && x.mapValue && x.mapValue.fields) || {}; }
function money(v) { return v == null ? null : '$' + Math.round(Number(v)).toLocaleString('en-US'); }

async function runQuery(cfg, structuredQuery) {
  const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents:runQuery?key=${cfg.apiKey}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }) });
  if (!res.ok) throw new Error('Firestore REST ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  const err = rows.find(r => r.error);
  if (err) throw new Error('Firestore query: ' + err.error.message);
  return rows.filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), fields: r.document.fields || {} }));
}
const whereEq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } });

// ---- Item shaping (pure; unit-tested) --------------------------------------
// Each queue item gets a stable key (collection-qualified doc id) and a
// human line for the issue body. Keys are what the state diffing runs on.
function shapeFlagged(doc) {
  const slug = fv(doc.fields.departmentSlug) || 'unknown department';
  const flags = ((doc.fields.automatedFlags || {}).arrayValue || {}).values || [];
  const reasons = flags.map(fv).filter(Boolean).join('; ') || 'flagged';
  return { key: 'flag:' + doc.id, line: `**${slug}** — ${reasons}` };
}

function shapeDispute(doc) {
  const slug = fv(doc.fields.departmentSlug) || 'unknown department';
  const field = fv(doc.fields.field) || 'entry';
  const reason = fv(doc.fields.reason);
  return { key: 'dispute:' + doc.id, line: `**${slug}** — ${field === 'stepPlan' ? 'pay-step plan flagged' : field + ' disputed'}${reason ? ': ' + String(reason).slice(0, 120) : ''}` };
}

// A compact "what it says" summary, mirroring the admin panel's field mapping.
function shapeSubmission(doc) {
  const slug = fv(doc.fields.departmentSlug) || fv(doc.fields.name) || 'unknown department';
  const pv = mapFields(doc.fields.proposedValues);
  const bits = [];
  const put = (label, v) => { if (v != null) bits.push(label + ' ' + money(v)); };
  put('entry', fv(pv.entry)); put('midpoint', fv(pv.midpoint)); put('top', fv(pv.top)); put('recruit', fv(pv.recruit));
  if (fv(pv.amount) != null) bits.push('figure ' + money(fv(pv.amount)));
  const sched = fv(pv.schedule) || fv(mapFields(doc.fields.plan).schedule);
  if (sched) bits.push('schedule ' + sched);
  const supp = ((pv.supplemental || {}).arrayValue || {}).values || [];
  if (supp.length) bits.push(supp.length + ' supplemental item' + (supp.length === 1 ? '' : 's'));
  return { key: 'sub:' + doc.id, line: `**${slug}** — ${bits.join(' · ') || 'working-conditions update'}` };
}

function submittedWithin(doc, hours, now) {
  const ts = doc.fields.submittedAt && doc.fields.submittedAt.timestampValue;
  const ms = ts ? Date.parse(ts) : NaN;
  return isFinite(ms) && (now - ms) <= hours * 3600 * 1000;
}

// ---- Issue body (pure; unit-tested) ----------------------------------------
const STATE_RE = /<!-- queue-state:(\[.*?\]) -->/;
function parseState(body) {
  const m = String(body || '').match(STATE_RE);
  try { return m ? JSON.parse(m[1]) : []; } catch (e) { return []; }
}

function renderBody(groups, generatedAt) {
  const keys = [].concat(groups.flagged, groups.disputes, groups.recent).map(i => i.key).sort();
  const section = (title, items, anchor) => items.length
    ? `## ${title} (${items.length})\n` + items.map(i => `- ${i.line}`).join('\n') + `\n\n[Review in the admin panel →](${SITE}/admin#${anchor})`
    : null;
  return [
    `Automated queue watch — last checked ${generatedAt}.`,
    section('Flagged submissions', groups.flagged, 'moderation'),
    section('Open disputes', groups.disputes, 'moderation'),
    section(`New submissions (last ${RECENT_HOURS / 24} days)`, groups.recent, 'activity'),
    `_Claims and new-department queues are admin-only and cannot be watched without credentials — glance at the [admin panel](${SITE}/admin#claims) while you're there._`,
    'cc @Texaspolicesalaries',
    `<!-- queue-state:${JSON.stringify(keys)} -->`
  ].filter(Boolean).join('\n\n');
}

function buildTitle(groups) {
  const bits = [];
  if (groups.flagged.length) bits.push(groups.flagged.length + ' flagged');
  if (groups.disputes.length) bits.push(groups.disputes.length + ' dispute' + (groups.disputes.length === 1 ? '' : 's'));
  if (groups.recent.length) bits.push(groups.recent.length + ' new submission' + (groups.recent.length === 1 ? '' : 's'));
  return 'Site needs review: ' + bits.join(', ');
}

// Which keys are new vs resolved/aged-out since the last run.
function computeDelta(prevKeys, currentKeys) {
  const prev = new Set(prevKeys);
  const cur = new Set(currentKeys);
  return {
    added: currentKeys.filter(k => !prev.has(k)),
    removed: prevKeys.filter(k => !cur.has(k))
  };
}

// ---- GitHub ----------------------------------------------------------------
function gh(pathname, init) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY not set');
  return fetch(`https://api.github.com/repos/${repo}${pathname}`, Object.assign({
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'texas-fire-salaries-queue-watch'
    }
  }, init));
}

async function findOpenAlert() {
  const res = await gh(`/issues?labels=${LABEL}&state=open&per_page=5`);
  if (!res.ok) throw new Error('GitHub list issues: ' + res.status);
  const rows = await res.json();
  return rows.find(r => !r.pull_request) || null;
}

async function ensureLabel() {
  const res = await gh('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'd93f0b', description: 'Automated: moderation queues need the admin' }) });
  if (!res.ok && res.status !== 422) throw new Error('GitHub create label: ' + res.status); // 422 = already exists
}

async function main() {
  const cfg = readConfig();
  const now = Date.now();
  const [flaggedDocs, disputeDocs, recentDocs] = await Promise.all([
    runQuery(cfg, { from: [{ collectionId: 'submissions' }], where: whereEq('status', 'flagged'), limit: 25 }),
    runQuery(cfg, { from: [{ collectionId: 'disputes' }], where: whereEq('status', 'open'), limit: 25 }),
    runQuery(cfg, { from: [{ collectionId: 'submissions' }], where: whereEq('status', 'published'), orderBy: [{ field: { fieldPath: 'submittedAt' }, direction: 'DESCENDING' }], limit: 15 })
  ]);
  const groups = {
    flagged: flaggedDocs.map(shapeFlagged),
    disputes: disputeDocs.map(shapeDispute),
    recent: recentDocs.filter(d => submittedWithin(d, RECENT_HOURS, now)).map(shapeSubmission)
  };
  const currentKeys = [].concat(groups.flagged, groups.disputes, groups.recent).map(i => i.key).sort();
  const body = renderBody(groups, new Date(now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  const title = buildTitle(groups);

  if (DRY) {
    console.log('[dry-run] keys:', currentKeys);
    console.log('[dry-run] title:', currentKeys.length ? title : '(no issue — all clear)');
    console.log('[dry-run] body:\n' + body);
    return;
  }

  const open = await findOpenAlert();
  if (!currentKeys.length) {
    if (open) {
      await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: 'All queues are clear — closing.' }) });
      await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      console.log('[notify] queues clear — closed #' + open.number);
    } else {
      console.log('[notify] queues clear — nothing to do');
    }
    return;
  }
  if (!open) {
    await ensureLabel();
    const res = await gh('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: [LABEL] }) });
    if (!res.ok) throw new Error('GitHub create issue: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    console.log('[notify] opened alert issue #' + (await res.json()).number);
    return;
  }
  const delta = computeDelta(parseState(open.body), currentKeys);
  if (delta.added.length) {
    const lines = [].concat(groups.flagged, groups.disputes, groups.recent)
      .filter(i => delta.added.includes(i.key)).map(i => `- ${i.line}`);
    await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
    await gh(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: 'New since last check:\n' + lines.join('\n') }) });
    console.log('[notify] #' + open.number + ': ' + delta.added.length + ' new item(s), commented');
  } else if (delta.removed.length) {
    // Something resolved or aged out — keep the body honest, no email.
    await gh(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
    console.log('[notify] #' + open.number + ': ' + delta.removed.length + ' item(s) gone, body refreshed');
  } else {
    console.log('[notify] #' + open.number + ': no change');
  }
}

module.exports = { fv, shapeFlagged, shapeDispute, shapeSubmission, submittedWithin, parseState, renderBody, buildTitle, computeDelta, RECENT_HOURS };

if (require.main === module) {
  main().catch(e => { console.error('[notify-queues] ' + (e && e.message || e)); process.exit(1); });
}
