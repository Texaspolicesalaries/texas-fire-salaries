#!/usr/bin/env node
/*
 * diag-firestore.js — One-shot diagnostic: where did my submission go?
 * Reads the public-read collections via the Firestore REST API (no credentials)
 * and prints counts + samples so we can see whether a correction landed as a
 * published submission, a dispute, or a confirmation.
 *   node scripts/diag-firestore.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'firebase-init.js'), 'utf8');
const projectId = (src.match(/projectId:\s*["']([^"']+)["']/) || [])[1];
const apiKey = (src.match(/apiKey:\s*["']([^"']+)["']/) || [])[1];
const URL = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

function fv(x) { if (!x) return undefined; return x.stringValue ?? x.integerValue ?? x.doubleValue ?? x.booleanValue ?? undefined; }

async function q(structuredQuery) {
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }) });
  const t = await res.text();
  if (!res.ok) return { error: res.status + ' ' + t.slice(0, 200) };
  let rows; try { rows = JSON.parse(t); } catch (e) { return { error: 'parse ' + e.message }; }
  if (rows && rows.error) return { error: rows.error.status + ' ' + rows.error.message };
  return { docs: (Array.isArray(rows) ? rows : []).filter(r => r.document) };
}

function show(name, r) {
  if (r.error) { console.log(`${name}: ⚠ ${r.error}`); return; }
  console.log(`${name}: ${r.docs.length} doc(s)`);
  r.docs.slice(0, 6).forEach(d => {
    const f = d.document.fields || {};
    const pv = (f.proposedValues && f.proposedValues.mapValue && f.proposedValues.mapValue.fields) || {};
    const kind = fv(f.submissionType) || fv(f.confirmationType) || fv(f.field) || '-';
    console.log(`   • dept=${fv(f.departmentSlug) || '?'} status=${fv(f.status) || '-'} kind=${kind} pv=[${Object.keys(pv).join(',')}] entry=${fv(pv.entry) ?? ''} amount=${fv(pv.amount) ?? ''}`);
  });
}

async function main() {
  console.log('project:', projectId, '\n');
  show('submissions (published)', await q({ from: [{ collectionId: 'submissions' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } } } }));
  show('submissions (flagged)', await q({ from: [{ collectionId: 'submissions' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'flagged' } } } }));
  show('disputes', await q({ from: [{ collectionId: 'disputes' }] }));
  show('confirmations', await q({ from: [{ collectionId: 'confirmations' }] }));
}
main().catch(e => console.error(e));
