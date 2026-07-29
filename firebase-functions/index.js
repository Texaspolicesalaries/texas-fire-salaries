/*
 * firebase-functions/index.js — OPTIONAL "aggregate on write" Cloud Function.
 *
 * The primary low-read path is the STATIC overlay (scripts/export-overlay.js +
 * a rebuild) — that already gives visitors 0 Firestore reads. This function is
 * only needed if you additionally want INSTANT-live department pages: it keeps a
 * compact `department_summaries/{slug}` doc fresh on every submission, so a page
 * can show live consensus with a single 1-read lookup (vs. re-querying all raw
 * submissions). Deploy needs Firebase connected; wire `firebase.json` →
 * "functions": { "source": "firebase-functions" } and `firebase deploy --only functions`.
 *
 * Reuses the shared pure logic in ../js/aggregate.js + ../js/derive.js so the
 * summary matches the rest of the site exactly.
 */
'use strict';
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
admin.initializeApp();

const Agg = require('../js/aggregate.js');   // pure, no browser deps

// Recompute one department's summary whenever a submission lands.
exports.aggregateSubmission = onDocumentCreated('submissions/{id}', async (event) => {
  const sub = event.data && event.data.data();
  const slug = sub && sub.departmentSlug;
  if (!slug) return;

  const db = admin.firestore();

  // Baseline department (steps/flags). Seed departments into Firestore first for
  // full fidelity; without it we summarize community reports alone.
  const deptSnap = await db.collection('departments').doc(slug).get();
  const dept = deptSnap.exists ? deptSnap.data() : { slug };

  // All published/flagged submissions for this department -> overlay reports.
  const subs = await db.collection('submissions')
    .where('departmentSlug', '==', slug)
    .where('status', 'in', ['published', 'flagged'])
    .get();
  const reports = [];
  subs.forEach(d => { const r = Agg.submissionToReport(d.data()); if (r) reports.push(r); });

  const summary = Agg.summarize(dept, reports, Date.now());
  await db.collection('department_summaries').doc(slug).set(summary, { merge: true });
});
