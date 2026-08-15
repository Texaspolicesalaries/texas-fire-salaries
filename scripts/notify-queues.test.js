/*
 * notify-queues.test.js — The pure halves of the queue watcher: REST decoding,
 * item shaping, state marker round-trip, and the new/resolved diffing that
 * decides whether the admin gets an email.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('./notify-queues.js');

const s = (v) => ({ stringValue: v });
const n = (v) => ({ integerValue: String(v) });

test('shapeFlagged names the department and joins the flag reasons', () => {
  const out = M.shapeFlagged({ id: 'abc', fields: {
    departmentSlug: s('anna-fd'),
    automatedFlags: { arrayValue: { values: [s('entry 62% above previous'), s('top below entry')] } }
  } });
  assert.strictEqual(out.key, 'flag:abc');
  assert.strictEqual(out.line, '**anna-fd** — entry 62% above previous; top below entry');
});

test('shapeDispute labels a step-plan flag differently from a value dispute', () => {
  const value = M.shapeDispute({ id: 'd1', fields: { departmentSlug: s('plano-fd'), field: s('entry'), reason: s('FY26 ordinance') } });
  assert.strictEqual(value.line, '**plano-fd** — entry disputed: FY26 ordinance');
  const plan = M.shapeDispute({ id: 'd2', fields: { departmentSlug: s('wylie-fd'), field: s('stepPlan') } });
  assert.strictEqual(plan.line, '**wylie-fd** — pay-step plan flagged');
});

test('shapeSubmission summarizes the proposed values compactly', () => {
  const out = M.shapeSubmission({ id: 's1', fields: {
    departmentSlug: s('anna-fd'),
    proposedValues: { mapValue: { fields: {
      entry: n(71200), recruit: n(63860), schedule: s('48/96'),
      supplemental: { arrayValue: { values: [{ mapValue: { fields: {} } }] } }
    } } }
  } });
  assert.strictEqual(out.key, 'sub:s1');
  assert.strictEqual(out.line, '**anna-fd** — entry $71,200 · recruit $63,860 · schedule 48/96 · 1 supplemental item');
});

test('shapeSubmission falls back to a working-conditions label when no figures', () => {
  const out = M.shapeSubmission({ id: 's2', fields: { departmentSlug: s('frisco-fd'), proposedValues: { mapValue: { fields: {} } } } });
  assert.strictEqual(out.line, '**frisco-fd** — working-conditions update');
});

test('submittedWithin respects the window', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const at = (iso) => ({ fields: { submittedAt: { timestampValue: iso } } });
  assert.strictEqual(M.submittedWithin(at('2026-08-14T12:00:00Z'), 72, now), true);
  assert.strictEqual(M.submittedWithin(at('2026-08-10T12:00:00Z'), 72, now), false);
  assert.strictEqual(M.submittedWithin({ fields: {} }, 72, now), false);
});

test('renderBody carries its own state marker and parseState reads it back', () => {
  const groups = {
    flagged: [{ key: 'flag:a', line: '**anna-fd** — out of range' }],
    disputes: [],
    recent: [{ key: 'sub:b', line: '**frisco-fd** — entry $85,000' }]
  };
  const body = M.renderBody(groups, '2026-08-15 12:00 UTC');
  assert.deepStrictEqual(M.parseState(body), ['flag:a', 'sub:b']);
  assert.ok(body.includes('## Flagged submissions (1)'));
  assert.ok(!body.includes('## Open disputes'));           // empty sections are omitted
  assert.ok(body.includes('/admin#moderation'));
  assert.deepStrictEqual(M.parseState('no marker here'), []);  // tolerates a hand-edited body
});

test('buildTitle counts only the non-empty queues', () => {
  assert.strictEqual(
    M.buildTitle({ flagged: [1], disputes: [], recent: [1, 2] }),
    'Site needs review: 1 flagged, 2 new submissions');
  assert.strictEqual(
    M.buildTitle({ flagged: [], disputes: [1], recent: [] }),
    'Site needs review: 1 dispute');
});

test('computeDelta separates new items (email) from resolved ones (silent)', () => {
  const d = M.computeDelta(['flag:a', 'sub:b'], ['sub:b', 'sub:c']);
  assert.deepStrictEqual(d.added, ['sub:c']);
  assert.deepStrictEqual(d.removed, ['flag:a']);
});
