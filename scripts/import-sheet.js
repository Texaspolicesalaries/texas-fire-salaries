#!/usr/bin/env node
/*
 * import-sheet.js — Convert the owner's Google-Sheet pay-plan export (CSV) into
 * data/departments.seed.json in the site's schema (see data/schema.md).
 *
 * Rerun whenever the sheet changes:
 *   1) File → Download → CSV from the sheet (or the CSV export URL) into
 *      data/dfw-fire-pay.csv
 *   2) node scripts/import-sheet.js [path-to-csv]
 *   3) npm run build
 *
 * The sheet gives one annual salary per year of service (0–12mo, 1yr, … 20yr+).
 * We collapse equal consecutive years into clean pay steps, treat each figure as
 * the published pay-plan BASE annual salary (no OT/incentive breakdown is known),
 * and attach a single "import" report so the consensus engine labels it
 * "Community reported / Current" until real contributors confirm it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSV = process.argv[2] || path.join(ROOT, 'data', 'dfw-fire-pay.csv');
const OUT = path.join(ROOT, 'data', 'departments.seed.json');

// Every county in this dataset is in the DFW / North Texas region.
const COUNTY_REGION = {
  Dallas: 'north-texas', Collin: 'north-texas', Tarrant: 'north-texas', Denton: 'north-texas',
  Johnson: 'north-texas', Ellis: 'north-texas', Rockwall: 'north-texas', Grayson: 'north-texas',
  Kaufman: 'north-texas', Parker: 'north-texas', Wise: 'north-texas'
};
const REGIONS = [
  { id: 'north-texas', name: 'North Texas (DFW)' }, { id: 'gulf-coast', name: 'Gulf Coast' },
  { id: 'central-texas', name: 'Central Texas' }, { id: 'south-texas', name: 'South Texas' },
  { id: 'west-texas', name: 'West Texas' }, { id: 'east-texas', name: 'East Texas' },
  { id: 'panhandle', name: 'Panhandle' }
];
const SCHEDULE_HOURS = { '48/96': 2912, '24/48': 2912, '24/72': 2184 };

function parseCSV(s) {
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
      else f += c;
    }
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const money = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
const numOf = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[,\s]/g, '')); return isFinite(n) ? n : null; };
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function isoDate(mdY) {
  const m = String(mdY || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function cleanName(raw) {
  let r = raw.trim().replace(/Waxahachhie/i, 'Waxahachie');
  if (/ESD/i.test(r)) return r;                                   // "Denton County ESD No. 1"
  if (/\bDPS$/i.test(r)) return r.replace(/\s+DPS$/i, '') + ' Department of Public Safety';
  if (/\bFD$/i.test(r)) return r.replace(/\s+FD$/i, '') + ' Fire Department';
  return r;
}
function cityFor(raw) {
  let r = raw.trim().replace(/Waxahachhie/i, 'Waxahachie');
  if (/ESD/i.test(r)) return r.replace(/\s+ESD.*$/i, '').trim();   // "Denton County"
  return r.replace(/\s+(FD|DPS)$/i, '').trim();
}
function typeFor(raw) {
  if (/ESD/i.test(raw)) return 'esd';
  if (/Airport/i.test(raw)) return 'airport';
  if (/\bDPS$/i.test(raw)) return 'combination';
  return 'municipal';
}

// Collapse the 21 per-year salary cells into clean, deduped steps.
function buildSteps(cells) {
  const vals = cells.map((c, i) => ({ month: i * 12, value: money(c) }));
  const present = vals.filter(v => v.value != null);
  if (!present.length) return null;
  const steps = [];
  for (let i = 0; i < present.length; i++) {
    const cur = present[i];
    if (steps.length && steps[steps.length - 1].value === cur.value) continue; // same run
    steps.push({ minMonths: cur.month, value: cur.value });
  }
  return steps.map((st, i) => {
    const next = steps[i + 1];
    const y = st.minMonths / 12;
    const stepName = st.minMonths === 0 ? 'Entry (0–12 mo)' : (next ? `${y} year${y === 1 ? '' : 's'}` : `${y}+ years (top)`);
    return {
      stepName,
      minimumMonths: st.minMonths,
      maximumMonths: next ? next.minMonths : null,
      classification: 'Firefighter',
      baseAnnualSalary: st.value
    };
  });
}

function loadLinks() {
  const p = path.join(ROOT, 'data', 'payplan-links.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

// Owner corrections that must survive every re-import (see the file's note).
function loadOverrides() {
  const p = path.join(ROOT, 'data', 'seed-overrides.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).overrides || {}; } catch (e) { return {}; }
}

function main() {
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const data = rows.slice(1);
  const links = loadLinks();                 // raw dept name -> pay-plan URL
  const overrides = loadOverrides();         // slug -> owner corrections
  const departments = [];

  data.forEach(r => {
    const rawName = (r[0] || '').trim();
    if (!rawName) return;
    const payPlanUrl = links[rawName] || '';
    const county = (r[4] || '').trim();
    const shift = (r[5] || '').trim();
    const coords = (r[r.length - 1] || '').split(',').map(x => parseFloat(x.trim()));
    const [lat, lng] = coords;
    const steps = buildSteps(r.slice(7, 28)); // 21 yearly columns: 0–12mo … 240+mo
    const lastUpdate = isoDate(r[2]);
    const population = numOf(r[3]);

    const dept = {
      // Typo fixes must reach the slug too — cleanName() already corrects the
      // display name, but a slug built from the raw sheet text would rename
      // the live page URL (waxahachhie-fd) on every re-import.
      slug: slugify(rawName.replace(/Waxahachhie/i, 'Waxahachie')),
      name: cleanName(rawName),
      city: cityFor(rawName),
      county,
      region: COUNTY_REGION[county] || 'north-texas',
      zip: '',
      lat: isFinite(lat) ? lat : null,
      lng: isFinite(lng) ? lng : null,
      departmentType: typeFor(rawName),
      website: '', careersUrl: '', phone: '',
      transportStatus: 'unknown',
      hiringStatus: 'unknown',
      scheduleType: shift || null,
      annualScheduledHours: SCHEDULE_HOURS[shift] || null,
      population: population || undefined,
      flags: { paramedicIncentive: false, certPay: false, educationPay: false, longevity: false, lateralsAccepted: false, emtRequired: false, paramedicRequired: false },
      dataStatus: steps ? 'current' : 'none'
    };

    if (steps) {
      const entry = steps[0].baseAnnualSalary;
      const top = steps[steps.length - 1].baseAnnualSalary;
      dept.salary = {
        effectiveDate: lastUpdate || null,
        includesScheduledOvertime: false,
        includesFlsaOvertime: false,
        sourceType: payPlanUrl ? 'official-pay-plan' : 'community',
        sourceUrl: payPlanUrl,
        classification: 'Firefighter',
        steps,
        reports: [{
          contributorId: 'dfw-fire-import',
          submittedAt: lastUpdate || null,
          entry, top,
          hasSource: !!payPlanUrl,
          departmentMaintained: false
        }]
      };
      // Some pay plans' first-year figure is the academy rate, not the entry
      // Firefighter step (schema.md: "recruitPay is never the first step" —
      // it would skew entry pay and every ranking). The sheet has no recruit
      // column, so the correction rides in data/seed-overrides.json.
      const ov = overrides[dept.slug];
      if (ov && ov.firstStepIsRecruit && dept.salary.steps.length > 1) {
        const academy = dept.salary.steps.shift();
        dept.salary.recruitPay = academy.baseAnnualSalary;
        dept.salary.reports[0].entry = dept.salary.steps[0].baseAnnualSalary;
        dept.salary.reports[0].recruit = academy.baseAnnualSalary;
      }
    }
    departments.push(dept);
  });

  departments.sort((a, b) => a.name.localeCompare(b.name));

  const out = {
    meta: {
      source: 'dfw-fire-pay.csv (owner-provided Google Sheet)',
      generated: new Date().toISOString().slice(0, 10),
      note: 'Imported from the owner\'s pay-plan sheet. Each figure is the published pay-plan annual salary per year of service (treated as base). No OT/incentive/transport/retirement breakdown was available; those fields are left blank for the community to fill in. Rerun scripts/import-sheet.js after updating the sheet.',
      disclaimer: 'Texas Fire Salaries is a community-maintained database. Compensation information may be incomplete, outdated, or incorrect. Always confirm current pay, benefits, and employment terms directly with the hiring department.'
    },
    regions: REGIONS,
    departments
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  const withSalary = departments.filter(d => d.salary).length;
  console.log(`Imported ${departments.length} departments (${withSalary} with pay data) -> data/departments.seed.json`);
}

main();
