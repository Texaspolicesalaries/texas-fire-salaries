#!/usr/bin/env node
/*
 * render-dept-cards.js — Pre-renders a 1200×630 social share card per
 * department into assets/branding/dept-cards/<slug>.png.
 *
 * Run LOCALLY (needs Google Chrome): node scripts/render-dept-cards.js
 * Options: --force re-renders cards that already exist.
 *
 * Deliberately an owner-run script, not part of the Pages build: the cloud
 * build must stay dependency-free and cannot run a browser. The cards carry
 * no salary figures for the same reason — the site's numbers refresh hourly
 * from Firestore, and a share card claiming last month's pay next to a page
 * showing this month's would break the site's honesty-first rule. Name, city
 * and branding never go stale. scripts/build-site.js picks a department's
 * card up automatically when the PNG exists, falling back to the generic
 * og-card.png when it doesn't (e.g. a newly promoted department) — rerun this
 * script and commit whenever departments are added.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'branding', 'dept-cards');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FORCE = process.argv.includes('--force');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function cardHtml(dept) {
  const name = dept.name || dept.slug;
  // Long names get a smaller face so two lines always fit above the tagline.
  const size = name.length > 30 ? 58 : name.length > 22 ? 66 : 76;
  const icon = 'file://' + path.join(ROOT, 'assets', 'branding', 'texas-fire-icon.png');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;650;780&family=Geist+Mono:wght@600&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1200px; height:630px; overflow:hidden; }
  body { font-family:"Geist",ui-sans-serif,system-ui,sans-serif; background:#152033; color:#fff; position:relative; }
  .accent { position:absolute; top:0; left:0; right:0; height:12px; background:#E84A3A; }
  .inner { position:absolute; inset:12px 0 0 0; padding:56px 84px 52px; display:flex; flex-direction:column; }
  .brand { display:flex; align-items:center; gap:20px; }
  .brand img { width:84px; height:84px; }
  .brand-name { font-size:34px; font-weight:780; letter-spacing:-0.02em; }
  .brand-sub { font-size:17px; font-weight:650; letter-spacing:0.14em; color:#EF6B5C; text-transform:uppercase; margin-top:6px; }
  h1 { font-size:${size}px; font-weight:780; letter-spacing:-0.03em; line-height:1.06; margin-top:56px; max-width:1010px; }
  .loc { font-size:31px; font-weight:500; color:#B9C2D0; margin-top:20px; }
  .tag { font-size:25px; font-weight:500; color:#8E99AB; margin-top:14px; }
  .foot { margin-top:auto; display:flex; align-items:center; gap:26px; }
  .pins { display:flex; gap:9px; }
  .pin { width:20px; height:20px; border-radius:50% 50% 50% 0; transform:rotate(-45deg); border:2.5px solid #fff; }
  .url { font-family:"Geist Mono",ui-monospace,Menlo,monospace; font-size:25px; font-weight:600; }
</style></head>
<body>
  <div class="accent"></div>
  <div class="inner">
    <div class="brand">
      <img src="${icon}" alt="">
      <div>
        <div class="brand-name">Texas Fire Salaries</div>
        <div class="brand-sub">Powered by the Community</div>
      </div>
    </div>
    <h1>${esc(name)}</h1>
    <div class="loc">${esc(dept.city)}, Texas · ${esc(dept.county)} County</div>
    <div class="tag">Community-reported firefighter pay, schedules, and career step plans</div>
    <div class="foot">
      <div class="pins">
        <span class="pin" style="background:#39455B"></span>
        <span class="pin" style="background:#101827"></span>
        <span class="pin" style="background:#B98A2E"></span>
        <span class="pin" style="background:#E84A3A"></span>
        <span class="pin" style="background:#174A7E"></span>
      </div>
      <span class="url">texasfiresalaries.com</span>
    </div>
  </div>
</body></html>`;
}

function main() {
  if (!fs.existsSync(CHROME)) {
    console.error('Chrome not found at ' + CHROME + ' — set CHROME_BIN to your Chrome binary.');
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'departments.seed.json'), 'utf8'));
  let overlayDepts = [];
  try { overlayDepts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'overlay.json'), 'utf8')).departments || []; } catch (e) { /* fine */ }
  const depts = (seed.departments || []).concat(overlayDepts);

  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-cards-'));
  let rendered = 0, skipped = 0;
  for (const d of depts) {
    if (!d.slug) continue;
    const png = path.join(OUT, d.slug + '.png');
    if (!FORCE && fs.existsSync(png)) { skipped++; continue; }
    const htmlFile = path.join(tmp, d.slug + '.html');
    fs.writeFileSync(htmlFile, cardHtml(d));
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--virtual-time-budget=4000', '--window-size=1200,630',
      '--screenshot=' + png, 'file://' + htmlFile
    ], { stdio: 'ignore' });
    rendered++;
    process.stdout.write('\r' + rendered + ' rendered…');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nDept cards: ' + rendered + ' rendered, ' + skipped + ' already existed, into ' + path.relative(ROOT, OUT) + '/');
}

main();
