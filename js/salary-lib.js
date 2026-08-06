/*
 * salary-lib.js — Pure compensation math for Texas Fire Salaries.
 *
 * No DOM, no globals, no Firebase. Everything here is a plain function so it
 * can be unit-tested under `node --test` and, later, shared with other sites.
 * Loaded in the browser as a plain (non-module) script exposing window.FireSalaryLib,
 * and via module.exports for Node tests.
 *
 * Core principle of the whole product: BASE salary and REPORTED TOTAL COMPENSATION
 * are never silently mixed. Callers pick which field they are projecting; this
 * module just does the arithmetic on the values it is handed.
 */

'use strict';

// ── Parsing / formatting ────────────────────────────────────────────────────

// "$74,356" | "74356" | 74356 -> 74356 ; junk/empty -> null
function parseMoney(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  var n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}

// "128,053" | 128053 -> 128053 ; junk/empty -> null
function parseNumber(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  var n = parseFloat(String(s).replace(/[,\s]/g, ''));
  return isFinite(n) ? n : null;
}

// Live-typing formatter for a money input: adds thousands separators to the
// integer part while leaving whatever the user is part-way through typing
// intact. Formatting on every keystroke is what makes the grouping feel
// automatic, but it means this function sees half-finished input constantly --
// so a trailing "." and trailing zeros after it MUST survive untouched.
// Round-tripping through parseFloat/toLocaleString does not: "25." loses the
// dot, so the next keystroke turns "25.5" into "255", and "25.50" ends up as
// 2,550 -- a 100x error that reads as a plausible salary. Digits and one
// decimal point are all that's kept; everything else (letters, a second dot,
// stray currency symbols) is dropped, and decimals are capped at 2 places.
function formatMoneyInput(raw) {
  var s = String(raw == null ? '' : raw).replace(/[^\d.]/g, '');
  if (!s) return '';
  var firstDot = s.indexOf('.');
  var intPart = firstDot === -1 ? s : s.slice(0, firstDot);
  // Everything after the first dot, with any further dots removed.
  var decPart = firstDot === -1 ? null : s.slice(firstDot + 1).replace(/\./g, '').slice(0, 2);
  var grouped = intPart ? Number(intPart).toLocaleString('en-US') : '';
  if (intPart && !isFinite(Number(intPart))) grouped = intPart;
  if (decPart === null) return grouped;
  return (grouped || '0') + '.' + decPart;   // keeps a trailing "." mid-typing
}

// A URL that is safe to place in an href. Community-submitted links (pay-plan
// sources, department websites) are auto-published and baked into the static
// site by the refresh cron, so they reach every visitor without a human ever
// looking at them. HTML-escaping is NOT enough here: esc() only neutralizes
// markup characters, and `javascript:alert(1)` contains none -- it survives
// intact into the href and runs on click. Only http/https are allowed through;
// anything else (javascript:, data:, vbscript:, file:, protocol-relative //,
// or a bare string) returns null so the caller can omit the link entirely.
// Applied at BOTH ends -- submit-time validation for the contributor's sake,
// and again in the export/build path, which is the last chokepoint before a
// URL becomes a live link and the only one that also covers documents written
// before this existed.
function safeUrl(u) {
  if (u == null) return null;
  var s = String(u).trim();
  if (!s) return null;
  // Strip control characters/whitespace that can hide a scheme ("java\tscript:").
  var probe = s.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (!/^https?:\/\/[^/]/.test(probe)) return null;
  return s;
}

function fmtMoney(n, opts) {
  var v = parseMoney(n);
  if (v == null) return '—';
  var cents = opts && opts.cents;
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0
  });
}

// ── Effective hourly ────────────────────────────────────────────────────────
// Firefighters commonly work long shift schedules (e.g. 2,912 scheduled hours/yr
// on a 24/48), so a raw annual figure is not comparable to a 2,080-hour desk job.
// Effective hourly = annual figure / scheduled annual hours.
function effectiveHourly(annualFigure, annualScheduledHours) {
  var a = parseMoney(annualFigure);
  var h = parseNumber(annualScheduledHours);
  if (a == null || h == null || h <= 0) return null;
  return a / h;
}

// Standard scheduled-hours references so callers/UI can offer sane defaults.
// These are the common firefighter shift cycles in Texas.
var SCHEDULE_HOURS = {
  '24/48': 2912,   // 1 on / 2 off (56 hr/week)
  '48/96': 2912,   // 2 on / 4 off (56 hr/week)
  '24/72': 2184,   // 1 on / 3 off (42 hr/week)
  '4/4 (Kelly)': 2756,
  '40-hour': 2080
};

function scheduleHours(scheduleName) {
  if (!scheduleName) return null;
  var key = String(scheduleName).trim();
  return Object.prototype.hasOwnProperty.call(SCHEDULE_HOURS, key) ? SCHEDULE_HOURS[key] : null;
}

// ── Step-plan projection / career earnings ──────────────────────────────────
//
// steps: ordered array of { minMonths:Number, maxMonths:Number|null, value:Number }
//   value is whichever field the caller chose (base OR reported comp) — never both.
//   maxMonths null/undefined means "open-ended top step".
// years: whole years of service to project (e.g. 5, 10, 20).
// opts.carryForward: when the plan runs out before `years`, repeat the final
//   step's value for the remaining years (clearly labeled by the returned flag).
//
// Assumption (documented to the user on the page): the step in effect at the
// START of each service year is used for that whole year.
function projectEarnings(steps, years, opts) {
  opts = opts || {};
  var carryForward = opts.carryForward !== false; // default true
  if (!Array.isArray(steps) || steps.length === 0 || !(years > 0)) {
    return { total: null, perYear: [], coveredYears: 0, assumedCarryForward: false };
  }
  var ordered = steps
    .filter(function (s) { return s && typeof s.value === 'number' && isFinite(s.value); })
    .slice()
    .sort(function (a, b) { return (a.minMonths || 0) - (b.minMonths || 0); });
  if (ordered.length === 0) {
    return { total: null, perYear: [], coveredYears: 0, assumedCarryForward: false };
  }
  var last = ordered[ordered.length - 1];
  var perYear = [];
  var assumedCarryForward = false;
  var coveredYears = 0;

  for (var y = 1; y <= years; y++) {
    var monthAtStart = (y - 1) * 12;
    var match = null;
    for (var i = 0; i < ordered.length; i++) {
      var s = ordered[i];
      var min = s.minMonths || 0;
      var max = (s.maxMonths == null) ? Infinity : s.maxMonths;
      if (monthAtStart >= min && monthAtStart < max) { match = s; break; }
    }
    if (match) {
      perYear.push(match.value);
      coveredYears++;
    } else if (monthAtStart < (ordered[0].minMonths || 0)) {
      // Before the first defined step — treat as the first step.
      perYear.push(ordered[0].value);
      coveredYears++;
    } else {
      // Past the end of the defined plan.
      if (carryForward) {
        perYear.push(last.value);
        coveredYears++;
        assumedCarryForward = true;
      } else {
        perYear.push(0);
      }
    }
  }

  var total = perYear.reduce(function (a, b) { return a + b; }, 0);
  return { total: total, perYear: perYear, coveredYears: coveredYears, assumedCarryForward: assumedCarryForward };
}

// Convenience: turn raw pay-step docs into the {minMonths,maxMonths,value} shape
// for a chosen field. field: 'baseAnnualSalary' | 'reportedAnnualCompensation' | ...
function stepsForField(payStepDocs, field) {
  if (!Array.isArray(payStepDocs)) return [];
  return payStepDocs
    .map(function (d) {
      var value = parseMoney(d[field]);
      if (value == null) return null;
      return {
        minMonths: parseNumber(d.minimumMonths) || 0,
        maxMonths: d.maximumMonths == null ? null : parseNumber(d.maximumMonths),
        value: value
      };
    })
    .filter(Boolean);
}

// Years-to-top: months where the top (open-ended / highest-min) step begins.
function yearsToTop(payStepDocs) {
  if (!Array.isArray(payStepDocs) || payStepDocs.length === 0) return null;
  var maxMin = -1;
  payStepDocs.forEach(function (d) {
    var m = parseNumber(d.minimumMonths);
    if (m != null && m > maxMin) maxMin = m;
  });
  if (maxMin < 0) return null;
  return Math.round((maxMin / 12) * 10) / 10;
}

// Derived summary of a full step pay plan. steps: [{ startMonths, basePay, isTopStep }].
// Entry = earliest valid step; top = the designated top step, else the latest step.
// Years-to-top = top step's startMonths / 12 (the underlying month value is preserved
// by the caller). entryToTopPct = percentage increase from entry base to top base.
function planSummary(steps) {
  var valid = (steps || []).filter(function (s) { return s && typeof s.basePay === 'number' && isFinite(s.basePay); });
  if (!valid.length) return { entry: null, top: null, topMonths: null, yearsToTop: null, entryToTopPct: null, count: 0 };
  var sorted = valid.slice().sort(function (a, b) { return (a.startMonths || 0) - (b.startMonths || 0); });
  var entry = sorted[0].basePay;
  var topStep = sorted.filter(function (s) { return s.isTopStep; })[0] || sorted[sorted.length - 1];
  var top = topStep.basePay;
  var topMonths = topStep.startMonths || 0;
  return {
    entry: entry,
    top: top,
    topMonths: topMonths,
    yearsToTop: Math.round((topMonths / 12) * 10) / 10,
    entryToTopPct: entry > 0 ? Math.round(((top - entry) / entry) * 1000) / 10 : null,
    count: valid.length
  };
}

// Per-step percentage increase in base pay vs the previous (sorted) step.
function stepIncreases(steps) {
  var sorted = (steps || []).filter(function (s) { return s && typeof s.basePay === 'number'; })
    .slice().sort(function (a, b) { return (a.startMonths || 0) - (b.startMonths || 0); });
  return sorted.map(function (s, i) {
    if (i === 0) return null;
    var prev = sorted[i - 1].basePay;
    return prev > 0 ? Math.round(((s.basePay - prev) / prev) * 1000) / 10 : null;
  });
}

// Automated moderation flags for one submitted figure, checked against the
// department's current displayed value for that same field. Deliberately just
// two categories — out-of-range and large-jump — "placeholder data" detection
// is left out on purpose: patterns like round numbers are too easy to
// false-positive on legitimate real-world pay figures.
var FLAG_MIN_REASONABLE = 15000;
var FLAG_MAX_REASONABLE = 400000;
var FLAG_JUMP_PCT = 50; // % change vs the department's current value

function flagFigure(fieldLabel, newValue, currentValue) {
  var flags = [];
  if (newValue == null || typeof newValue !== 'number' || !isFinite(newValue)) return flags;
  if (newValue > FLAG_MAX_REASONABLE) flags.push(fieldLabel + ': unusually high ($' + Math.round(newValue).toLocaleString('en-US') + ')');
  else if (newValue < FLAG_MIN_REASONABLE) flags.push(fieldLabel + ': unusually low ($' + Math.round(newValue).toLocaleString('en-US') + ')');
  if (currentValue != null && currentValue > 0) {
    var pct = ((newValue - currentValue) / currentValue) * 100;
    if (Math.abs(pct) > FLAG_JUMP_PCT) {
      flags.push(fieldLabel + ': ' + (pct > 0 ? '+' : '') + Math.round(pct) + '% vs current $' + Math.round(currentValue).toLocaleString('en-US'));
    }
  }
  return flags;
}

var FireSalaryLib = {
  parseMoney: parseMoney,
  formatMoneyInput: formatMoneyInput,
  safeUrl: safeUrl,
  parseNumber: parseNumber,
  fmtMoney: fmtMoney,
  effectiveHourly: effectiveHourly,
  scheduleHours: scheduleHours,
  SCHEDULE_HOURS: SCHEDULE_HOURS,
  projectEarnings: projectEarnings,
  stepsForField: stepsForField,
  yearsToTop: yearsToTop,
  planSummary: planSummary,
  stepIncreases: stepIncreases,
  flagFigure: flagFigure,
  FLAG_MIN_REASONABLE: FLAG_MIN_REASONABLE,
  FLAG_MAX_REASONABLE: FLAG_MAX_REASONABLE,
  FLAG_JUMP_PCT: FLAG_JUMP_PCT
};

if (typeof window !== 'undefined') window.FireSalaryLib = FireSalaryLib;
if (typeof module !== 'undefined' && module.exports) module.exports = FireSalaryLib;
