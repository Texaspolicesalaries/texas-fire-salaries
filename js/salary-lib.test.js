'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./salary-lib.js');

test('planSummary derives entry, top, years-to-top, entry-to-top %', () => {
  var steps = [
    { startMonths: 0, basePay: 60000 },
    { startMonths: 12, basePay: 66000 },
    { startMonths: 48, basePay: 78000 }
  ];
  var s = L.planSummary(steps);
  assert.strictEqual(s.entry, 60000);          // earliest step
  assert.strictEqual(s.top, 78000);            // latest step (no explicit top)
  assert.strictEqual(s.topMonths, 48);
  assert.strictEqual(s.yearsToTop, 4);         // 48/12
  assert.strictEqual(s.entryToTopPct, 30);     // (78000-60000)/60000
  assert.strictEqual(s.count, 3);
});

test('planSummary honors an explicit top step and unordered input', () => {
  var steps = [
    { startMonths: 48, basePay: 90000 },       // latest, but NOT marked top
    { startMonths: 0, basePay: 60000 },
    { startMonths: 24, basePay: 80000, isTopStep: true }  // designated top
  ];
  var s = L.planSummary(steps);
  assert.strictEqual(s.entry, 60000);
  assert.strictEqual(s.top, 80000);            // the designated top, not the latest
  assert.strictEqual(s.topMonths, 24);
  assert.strictEqual(s.yearsToTop, 2);
});

test('planSummary is null-safe with no valid steps', () => {
  assert.strictEqual(L.planSummary([]).entry, null);
  assert.strictEqual(L.planSummary([{ startMonths: 0 }]).top, null);
});

test('stepIncreases gives per-step percentage lift', () => {
  var inc = L.stepIncreases([{ startMonths: 0, basePay: 100 }, { startMonths: 12, basePay: 110 }, { startMonths: 24, basePay: 121 }]);
  assert.strictEqual(inc[0], null);
  assert.strictEqual(inc[1], 10);
  assert.strictEqual(inc[2], 10);
});

test('parseMoney handles strings, numbers, junk', () => {
  assert.strictEqual(L.parseMoney('$74,356'), 74356);
  assert.strictEqual(L.parseMoney('74356'), 74356);
  assert.strictEqual(L.parseMoney(74356), 74356);
  assert.strictEqual(L.parseMoney(''), null);
  assert.strictEqual(L.parseMoney(null), null);
  assert.strictEqual(L.parseMoney('n/a'), null);
});

// The money inputs reformat on every keystroke, so this function sees
// half-finished input constantly. Typing is simulated character by character
// because that is the only way the original bug showed up: each pass fed its
// own output back in, and "25." losing its dot turned $25.50/hr into $2,550/hr.
function typeInto(str) {
  var buf = '';
  String(str).split('').forEach(function (ch) { buf = L.formatMoneyInput(buf + ch); });
  return buf;
}

test('formatMoneyInput survives typing a decimal one character at a time', () => {
  assert.strictEqual(typeInto('25.50'), '25.50');
  assert.strictEqual(L.parseMoney(typeInto('25.50')), 25.5);
  assert.strictEqual(typeInto('7.5'), '7.5');
  assert.strictEqual(L.parseMoney(typeInto('7.5')), 7.5);
});

test('formatMoneyInput groups thousands while typing', () => {
  assert.strictEqual(typeInto('61500'), '61,500');
  assert.strictEqual(L.parseMoney(typeInto('61500')), 61500);
  assert.strictEqual(typeInto('1234567'), '1,234,567');
});

test('formatMoneyInput keeps a trailing dot so the next keystroke lands correctly', () => {
  assert.strictEqual(L.formatMoneyInput('25.'), '25.');
  assert.strictEqual(L.formatMoneyInput('25.5'), '25.5');
  assert.strictEqual(L.formatMoneyInput('25.50'), '25.50'); // trailing zero preserved
});

test('formatMoneyInput drops junk, extra dots, and caps at two decimals', () => {
  assert.strictEqual(L.formatMoneyInput('abc'), '');
  assert.strictEqual(L.formatMoneyInput('1.2.3'), '1.23');
  assert.strictEqual(L.formatMoneyInput('1234.567'), '1,234.56');
  assert.strictEqual(L.formatMoneyInput('$1,000'), '1,000');
  assert.strictEqual(L.formatMoneyInput('.5'), '0.5');
  assert.strictEqual(L.formatMoneyInput(''), '');
  assert.strictEqual(L.formatMoneyInput(null), '');
});

test('safeUrl passes http/https and rejects script-bearing schemes', () => {
  assert.strictEqual(L.safeUrl('https://example.com/plan.pdf'), 'https://example.com/plan.pdf');
  assert.strictEqual(L.safeUrl('http://example.com'), 'http://example.com');
  assert.strictEqual(L.safeUrl('HTTPS://EXAMPLE.COM/p'), 'HTTPS://EXAMPLE.COM/p');
  assert.strictEqual(L.safeUrl('javascript:alert(1)'), null);
  assert.strictEqual(L.safeUrl('JavaScript:alert(1)'), null);
  assert.strictEqual(L.safeUrl('  javascript:alert(1)  '), null);
  assert.strictEqual(L.safeUrl('data:text/html,<script>x</script>'), null);
  assert.strictEqual(L.safeUrl('vbscript:msgbox'), null);
  assert.strictEqual(L.safeUrl('//evil.example.com'), null); // protocol-relative
  assert.strictEqual(L.safeUrl('asdf'), null);               // not a URL at all
  assert.strictEqual(L.safeUrl(''), null);
  assert.strictEqual(L.safeUrl(null), null);
});

test('safeUrl ignores control characters hiding a scheme', () => {
  assert.strictEqual(L.safeUrl('java\tscript:alert(1)'), null);
  assert.strictEqual(L.safeUrl('java\nscript:alert(1)'), null);
  assert.strictEqual(L.safeUrl('\u0000javascript:alert(1)'), null);
});

// Supplemental pay was collected from contributors and stored faithfully, but
// nothing rendered it — it only ever became a boolean filter flag. These cover
// the consolidation that makes it displayable.
test('consolidateSupplemental keeps the most recent amount per pay type', () => {
  const out = L.consolidateSupplemental([
    { submittedAt: '2026-01-01', supplemental: [{ type: 'paramedic-incentive', amount: 400, unit: 'mo' }] },
    { submittedAt: '2026-08-06', supplemental: [{ type: 'paramedic-incentive', amount: 500, unit: 'mo' }] }
  ]);
  assert.strictEqual(out.length, 1, 'one row per type, not one per submission');
  assert.strictEqual(out[0].amount, 500);
});

test('consolidateSupplemental merges across reports and orders by kind', () => {
  const out = L.consolidateSupplemental([
    { submittedAt: '2026-01-01', supplemental: [{ type: 'edu-bachelor', amount: 240, unit: 'mo' }] },
    { submittedAt: '2026-02-01', supplemental: [{ type: 'paramedic-incentive', amount: 500, unit: 'mo' }] }
  ]);
  assert.deepStrictEqual(out.map(x => x.type), ['paramedic-incentive', 'edu-bachelor']);
});

test('consolidateSupplemental drops entries with no usable amount', () => {
  const out = L.consolidateSupplemental([
    { submittedAt: '2026-01-01', supplemental: [{ type: 'longevity' }, { type: '', amount: 5 }, { type: 'bilingual', amount: 200, unit: 'mo' }] }
  ]);
  assert.deepStrictEqual(out.map(x => x.type), ['bilingual']);
});

test('consolidateSupplemental is safe on empty/missing input', () => {
  assert.deepStrictEqual(L.consolidateSupplemental([]), []);
  assert.deepStrictEqual(L.consolidateSupplemental(null), []);
  assert.deepStrictEqual(L.consolidateSupplemental([{ submittedAt: '2026-01-01' }]), []);
});

// "Other" exists because the fixed list can't name every department's pay. Two
// differently-named Other items must both survive — keying on type alone would
// silently drop one and show the survivor's amount under the wrong name.
test('consolidateSupplemental keeps distinct named Other items apart', () => {
  const out = L.consolidateSupplemental([{
    submittedAt: '2026-01-01',
    supplemental: [
      { type: 'other', label: 'Hazmat team stipend', amount: 150, unit: 'mo' },
      { type: 'other', label: 'Dive team pay', amount: 100, unit: 'mo' }
    ]
  }]);
  assert.strictEqual(out.length, 2, 'both Other items must survive');
  const byName = {};
  out.forEach(o => { byName[L.supplementalLabel(o.type, o.label)] = o.amount; });
  assert.strictEqual(byName['Hazmat team stipend'], 150);
  assert.strictEqual(byName['Dive team pay'], 100);
});

test('consolidateSupplemental still dedupes the SAME Other, newest winning, ignoring case', () => {
  const out = L.consolidateSupplemental([
    { submittedAt: '2026-01-01', supplemental: [{ type: 'other', label: 'Hazmat team stipend', amount: 100, unit: 'mo' }] },
    { submittedAt: '2026-08-01', supplemental: [{ type: 'other', label: 'Hazmat Team Stipend', amount: 175, unit: 'mo' }] }
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].amount, 175);
});

test('supplementalLabel prefers a contributor-supplied name', () => {
  assert.strictEqual(L.supplementalLabel('other', 'Tiller pay'), 'Tiller pay');
  assert.strictEqual(L.supplementalLabel('other'), 'Other');
  assert.strictEqual(L.supplementalLabel('paramedic-incentive'), 'Paramedic incentive');
});

test('supplementalKey separates named Others but leaves known types alone', () => {
  assert.notStrictEqual(L.supplementalKey('other', 'A'), L.supplementalKey('other', 'B'));
  assert.strictEqual(L.supplementalKey('other', 'A'), L.supplementalKey('other', ' a '));
  assert.strictEqual(L.supplementalKey('longevity'), 'longevity');
});

// An unrecognized schedule makes scheduleHours return null, and derive.js then
// assumes 2,912 hours — so a modified cycle needs its hours supplied or the
// effective-hourly figure is quietly wrong.
test('scheduleHours returns null for a modified schedule, which is what triggers the prompt', () => {
  assert.strictEqual(L.scheduleHours('Modified 24-hour (24 on/72 off; 48 on/72 off)'), null);
  assert.strictEqual(L.scheduleHours('24/48'), 2912);
});

test('supplementalAnnual converts monthly and yearly, refuses percentages', () => {
  assert.strictEqual(L.supplementalAnnual({ amount: 500, unit: 'mo' }), 6000);
  assert.strictEqual(L.supplementalAnnual({ amount: 1000, unit: 'yr' }), 1000);
  // A percentage depends on which step's base it applies to — converting it
  // would invent precision, so callers must render it as a percentage.
  assert.strictEqual(L.supplementalAnnual({ amount: 2, unit: 'pct' }), null);
  assert.strictEqual(L.supplementalAnnual({ amount: 3, unit: 'hr' }), null);
  assert.strictEqual(L.supplementalAnnual(null), null);
});

// The history timeline printed entry/top on every card regardless of content, so
// a revision that added recruit pay looked identical to one that changed nothing.
test('describeRevisionChanges reports only what actually moved', () => {
  const out = L.describeRevisionChanges(
    { entry: 76529, top: 79000, recruit: 65045 },
    { entry: 76529, top: 76208 }
  );
  assert.deepStrictEqual(out.map(c => c.label), ['Top pay', 'Recruit / academy pay']);
  assert.strictEqual(out[0].from, 76208);      // changed
  assert.strictEqual(out[1].from, null);       // added
});

test('describeRevisionChanges treats the earliest revision as all-added', () => {
  const out = L.describeRevisionChanges({ entry: 60000, top: 78000 }, null);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every(c => c.from === null));
});

test('describeRevisionChanges returns nothing when a revision changed no figure', () => {
  const same = { entry: 60000, top: 78000 };
  assert.deepStrictEqual(L.describeRevisionChanges(same, { entry: 60000, top: 78000 }), []);
});

test('describeRevisionChanges counts supplemental items as their own change', () => {
  const out = L.describeRevisionChanges(
    { entry: 60000, supplemental: [1, 2, 3] },
    { entry: 60000 }
  );
  assert.deepStrictEqual(out, [{ label: 'Supplemental pay items', from: 0, to: 3, kind: 'count' }]);
});

test('fmtMoney formats and guards', () => {
  assert.strictEqual(L.fmtMoney(74356), '$74,356');
  assert.strictEqual(L.fmtMoney(null), '—');
  assert.strictEqual(L.fmtMoney(12.5, { cents: true }), '$12.50');
});

test('effectiveHourly divides annual by scheduled hours', () => {
  // 24/48 schedule = 2912 hrs; $75,712 base -> $26.00/hr
  assert.strictEqual(L.effectiveHourly(75712, 2912), 26);
  assert.strictEqual(L.effectiveHourly('$75,712', '2,912'), 26);
  assert.strictEqual(L.effectiveHourly(75000, 0), null);
  assert.strictEqual(L.effectiveHourly(null, 2912), null);
});

test('scheduleHours maps known cycles', () => {
  assert.strictEqual(L.scheduleHours('24/48'), 2912);
  assert.strictEqual(L.scheduleHours('40-hour'), 2080);
  assert.strictEqual(L.scheduleHours('unknown'), null);
});

test('projectEarnings sums per-year values from a step plan', () => {
  // Steps: 0-12mo=$50k, 12-24mo=$55k, 24mo+ (top)=$60k
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 },
    { minMonths: 24, maxMonths: null, value: 60000 }
  ];
  const r5 = L.projectEarnings(steps, 5);
  // Y1 50k, Y2 55k, Y3 60k, Y4 60k, Y5 60k = 285k
  assert.strictEqual(r5.total, 285000);
  assert.deepStrictEqual(r5.perYear, [50000, 55000, 60000, 60000, 60000]);
  // Open-ended top step covers years 3-5 by definition -> no assumption flagged.
  assert.strictEqual(r5.assumedCarryForward, false);
  assert.strictEqual(r5.coveredYears, 5);
});

test('projectEarnings flags carry-forward past a BOUNDED final step', () => {
  // Final step is bounded (24-36mo). Projecting to year 5 must carry it forward.
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 },
    { minMonths: 24, maxMonths: 36, value: 60000 }
  ];
  const r5 = L.projectEarnings(steps, 5);
  // Y1 50k, Y2 55k, Y3 60k, Y4 & Y5 carried from 60k = 285k
  assert.strictEqual(r5.total, 285000);
  assert.strictEqual(r5.assumedCarryForward, true);
});

test('projectEarnings without carryForward stops projecting past the plan', () => {
  const steps = [
    { minMonths: 0, maxMonths: 12, value: 50000 },
    { minMonths: 12, maxMonths: 24, value: 55000 }
  ];
  const r = L.projectEarnings(steps, 4, { carryForward: false });
  // Y1 50k, Y2 55k, Y3 & Y4 past plan -> 0
  assert.strictEqual(r.total, 105000);
  assert.strictEqual(r.assumedCarryForward, false);
});

test('projectEarnings guards bad input', () => {
  assert.strictEqual(L.projectEarnings([], 5).total, null);
  assert.strictEqual(L.projectEarnings(null, 5).total, null);
  assert.strictEqual(L.projectEarnings([{ minMonths: 0, value: 50000 }], 0).total, null);
});

test('stepsForField picks the requested field and drops blanks', () => {
  const docs = [
    { minimumMonths: 0, maximumMonths: 12, baseAnnualSalary: '$50,000', reportedAnnualCompensation: '$70,000' },
    { minimumMonths: 12, maximumMonths: null, baseAnnualSalary: '', reportedAnnualCompensation: '$75,000' }
  ];
  const base = L.stepsForField(docs, 'baseAnnualSalary');
  assert.strictEqual(base.length, 1);
  assert.strictEqual(base[0].value, 50000);
  const rep = L.stepsForField(docs, 'reportedAnnualCompensation');
  assert.strictEqual(rep.length, 2);
  assert.strictEqual(rep[1].maxMonths, null);
});

test('yearsToTop reads the highest step start', () => {
  const docs = [
    { minimumMonths: 0 }, { minimumMonths: 12 }, { minimumMonths: 48 }
  ];
  assert.strictEqual(L.yearsToTop(docs), 4);
  assert.strictEqual(L.yearsToTop([]), null);
});

test('flagFigure raises no flags for a reasonable value close to current', () => {
  assert.deepStrictEqual(L.flagFigure('Entry pay', 61000, 60000), []);
});

test('flagFigure flags a value above the reasonable maximum', () => {
  const flags = L.flagFigure('Entry pay', 450000, null);
  assert.strictEqual(flags.length, 1);
  assert.match(flags[0], /unusually high/);
});

test('flagFigure flags a value below the reasonable minimum', () => {
  const flags = L.flagFigure('Entry pay', 8000, null);
  assert.strictEqual(flags.length, 1);
  assert.match(flags[0], /unusually low/);
});

test('flagFigure flags a large jump vs the department\'s current value', () => {
  const flags = L.flagFigure('Top pay', 150000, 78000); // +92%
  assert.strictEqual(flags.length, 1);
  assert.match(flags[0], /\+92% vs current \$78,000/);
});

test('flagFigure does not flag a large jump when there is no current value to compare against', () => {
  assert.deepStrictEqual(L.flagFigure('Entry pay', 150000, null), []);
  assert.deepStrictEqual(L.flagFigure('Entry pay', 150000, 0), []);
});

test('flagFigure can raise both an out-of-range and a large-jump flag together', () => {
  const flags = L.flagFigure('Entry pay', 450000, 60000);
  assert.strictEqual(flags.length, 2);
});

test('flagFigure is null-safe and ignores non-numeric input', () => {
  assert.deepStrictEqual(L.flagFigure('Entry pay', null, 60000), []);
  assert.deepStrictEqual(L.flagFigure('Entry pay', undefined, 60000), []);
});
