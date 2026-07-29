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

var FireSalaryLib = {
  parseMoney: parseMoney,
  parseNumber: parseNumber,
  fmtMoney: fmtMoney,
  effectiveHourly: effectiveHourly,
  scheduleHours: scheduleHours,
  SCHEDULE_HOURS: SCHEDULE_HOURS,
  projectEarnings: projectEarnings,
  stepsForField: stepsForField,
  yearsToTop: yearsToTop
};

if (typeof window !== 'undefined') window.FireSalaryLib = FireSalaryLib;
if (typeof module !== 'undefined' && module.exports) module.exports = FireSalaryLib;
