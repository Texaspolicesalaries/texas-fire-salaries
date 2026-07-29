#!/usr/bin/env node
/*
 * extract-links.js — Recover the "Link to Pay Plan" hyperlinks from the owner's
 * sheet. CSV export strips hyperlink URLs, but the XLSX export keeps them.
 *
 * Reads data/dfw-fire-pay.xlsx, finds the data worksheet (the one with the most
 * pay-plan hyperlinks), maps each department (column A) to its pay-plan URL
 * (column B hyperlink), and writes data/payplan-links.json keyed by the raw
 * department name so scripts/import-sheet.js can attach a real sourceUrl.
 *
 * Rerun after updating the sheet:
 *   File → Download → Microsoft Excel (.xlsx)  →  data/dfw-fire-pay.xlsx
 *   node scripts/extract-links.js && node scripts/import-sheet.js && npm run build
 *
 * Uses the system `unzip` (xlsx is a zip); no npm deps.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const XLSX = process.argv[2] || path.join(ROOT, 'data', 'dfw-fire-pay.xlsx');
const OUT = path.join(ROOT, 'data', 'payplan-links.json');

function unzip(entry) {
  try { return execFileSync('unzip', ['-p', XLSX, entry], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); }
  catch (e) { return ''; }
}
function listEntries() {
  return execFileSync('unzip', ['-Z1', XLSX], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8').split('\n');
}

function parseSharedStrings() {
  const xml = unzip('xl/sharedStrings.xml');
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = re.exec(xml))) {
    const texts = (m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, ''));
    out.push(decode(texts.join('')));
  }
  return out;
}
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function relsTargets(sheetFile) {
  const rels = unzip(`xl/worksheets/_rels/${sheetFile}.rels`);
  const map = {}; const re = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g; let m;
  while ((m = re.exec(rels))) map[m[1]] = m[2];
  return map;
}

function main() {
  const entries = listEntries();
  const sheetFiles = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).map(e => path.basename(e));

  // Pick the worksheet with the most external hyperlink rels (the data tab).
  let best = null, bestCount = -1;
  sheetFiles.forEach(sf => {
    const t = relsTargets(sf);
    const n = Object.values(t).filter(u => /^https?:\/\//.test(u)).length;
    if (n > bestCount) { bestCount = n; best = sf; }
  });
  if (!best) { console.error('No worksheet with hyperlinks found.'); process.exit(1); }

  const ss = parseSharedStrings();
  const targets = relsTargets(best);
  const xml = unzip(`xl/worksheets/${best}`);

  // row -> pay-plan URL (hyperlink on column B)
  const rowUrl = {};
  const hlRe = /<hyperlink[^>]*r:id="(rId\d+)"[^>]*ref="B(\d+)"|<hyperlink[^>]*ref="B(\d+)"[^>]*r:id="(rId\d+)"/g; let h;
  while ((h = hlRe.exec(xml))) {
    const rid = h[1] || h[4]; const row = h[2] || h[3];
    if (rid && row && targets[rid]) rowUrl[row] = targets[rid];
  }

  // row -> department name (shared-string cell in column A)
  const rowName = {};
  const cellRe = /<c r="A(\d+)"[^>]*t="s"[^>]*>\s*<v>(\d+)<\/v>/g; let c;
  while ((c = cellRe.exec(xml))) { const row = c[1], idx = parseInt(c[2], 10); if (ss[idx] != null) rowName[row] = ss[idx].trim(); }

  const links = {};
  Object.keys(rowUrl).forEach(row => { const name = rowName[row]; if (name) links[name] = rowUrl[row]; });

  fs.writeFileSync(OUT, JSON.stringify(links, null, 2) + '\n');
  console.log(`Data sheet: ${best} (${bestCount} links). Extracted ${Object.keys(links).length} pay-plan URLs -> data/payplan-links.json`);
}

main();
