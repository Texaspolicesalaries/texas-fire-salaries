/*
 * site-integrity.test.js — Build-output smoke checks, zero dependencies.
 *
 * The unit suite exercises the pure math; every shipping bug this project has
 * actually had lived in the seams instead: a page referencing a stylesheet
 * that no longer exists (the repo keeps dated file variants and only some are
 * live), a hand-typed department slug that stops matching the seed data, a
 * page missing its share metadata. These checks walk the real files on disk —
 * the same ones Cloudflare Pages serves — and fail the suite when a seam
 * breaks. Runs under `npm test` via the scripts/*.test.js glob; needs no
 * server, no browser, no network.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readdirHtml(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Root pages plus every generated page that exists in this checkout. The
// generated sets are rebuilt by `npm run build`, so their presence here means
// they are exactly what a deploy would publish.
function allPages() {
  const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => path.join(ROOT, f));
  for (const dir of ['departments', 'counties', 'regions', 'rankings']) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) pages.push(...readdirHtml(p));
  }
  return pages;
}

test('every local /js and /css reference resolves to a real file', () => {
  const missing = [];
  for (const page of allPages()) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"?]+)(?:\?[^"]*)?"/g)) {
      const asset = path.join(ROOT, m[1].replace(/^\//, ''));
      if (!fs.existsSync(asset)) missing.push(`${path.relative(ROOT, page)} -> ${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'pages reference assets that do not exist:\n' + missing.join('\n'));
});

test('every page is complete and carries share metadata', () => {
  const problems = [];
  for (const page of allPages()) {
    const rel = path.relative(ROOT, page);
    const html = fs.readFileSync(page, 'utf8');
    if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${rel}: missing <title>`);
    if (!html.includes('og:image')) problems.push(`${rel}: missing og:image`);
    if (!html.trimEnd().endsWith('</html>')) problems.push(`${rel}: truncated (no closing </html>)`);
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('og:image files referenced by pages exist', () => {
  const missing = new Set();
  for (const page of allPages()) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(/property="og:image" content="https:\/\/texasfiresalaries\.com(\/[^"]+)"/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1].replace(/^\//, '')))) missing.add(m[1]);
    }
  }
  assert.deepStrictEqual([...missing], [], 'og:image points at files that do not exist: ' + [...missing].join(', '));
});

test('department slugs hand-typed into pages and scripts exist in the data', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'departments.seed.json'), 'utf8'));
  const known = new Set((seed.departments || []).map(d => d.slug));
  // Overlay-promoted departments are also linkable.
  try {
    const overlay = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'overlay.json'), 'utf8'));
    (overlay.departments || []).forEach(d => known.add(d.slug));
  } catch (e) { /* no overlay in a fresh checkout — seed slugs still checked */ }

  // The compare page's example chips are the one place slugs are hand-typed in
  // JS; a department rename in the seed must not silently 404 them.
  const compare = fs.readFileSync(path.join(ROOT, 'js', 'compare.js'), 'utf8');
  const bad = [];
  for (const m of compare.matchAll(/compare\.html\?d=([a-z0-9,-]+)/g)) {
    for (const slug of m[1].split(',')) {
      if (!known.has(slug)) bad.push(slug);
    }
  }
  assert.deepStrictEqual(bad, [], 'compare.js example slugs missing from data: ' + bad.join(', '));
});

test('seed department slugs are unique', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'departments.seed.json'), 'utf8'));
  const seen = new Set(), dupes = [];
  for (const d of seed.departments || []) {
    if (seen.has(d.slug)) dupes.push(d.slug);
    seen.add(d.slug);
  }
  assert.deepStrictEqual(dupes, [], 'duplicate slugs: ' + dupes.join(', '));
});
