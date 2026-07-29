# Texas Fire Salaries

A statewide, **community-maintained** firefighter compensation map and comparison
database for Texas. Verified contributors submit, confirm, and dispute pay; consensus
and freshness are computed automatically so the owner mainly moderates — not researches.

Built to match the sibling **Texas Police Salaries** stack for easy service-sharing:
vanilla HTML/JS · Firebase (Auth + Firestore + Storage) · Leaflet + MarkerCluster maps ·
Cloudflare Pages/Functions. Business logic is pure and unit-tested, separate from the UI.

---

## Quick start

```bash
npm install         # dev tooling only (wrangler, firebase-tools)
npm test            # run the pure-logic unit tests (no network needed)
npm run build       # generate department/ranking pages + sitemap from the seed
npm run serve       # static preview at http://localhost:8788
# or: npm run dev   # build + serve
```

The site works **read-only with no backend** off `data/departments.seed.json`. Auth and
submissions light up once you connect Firebase (below); until then those flows run in a
clearly-labeled preview mode.

## Project layout

```
index.html  map.html  departments.html  compare.html  submit.html
how-it-works.html  sign-in.html  admin.html  + legal pages  404.html
css/            tokens.css · base.css · components.css   (data-atlas design system)
js/
  salary-lib.js   consensus.js   derive.js     ← pure, testable (also run in Node build)
  data.js  filters.js  filters-ui.js  ui.js  compare-store.js
  firebase-init.js  auth.js
  nav.js  home.js  map.js  directory.js  compare.js  submit.js  department.js  sign-in.js  admin.js
  *.test.js       ← node --test
data/           departments.seed.json  ·  schema.md (import format)
scripts/        build-site.js (static generator)  ·  serve.js (dev server)
firestore.rules  firestore.indexes.json  storage.rules  firebase.json
functions/  workers/reminders/   ← Cloudflare edge + scheduled scaffolds
wrangler.jsonc  _headers  _redirects  robots.txt
```

## Connect Firebase (owner handoff #2)

1. Create a Firebase project; enable **Authentication** (Google + Email/Password, require
   email verification), **Firestore**, and **Storage**.
2. Paste your web config into `js/firebase-init.js` (`FIREBASE_CONFIG`).
3. Set your admin email in `firestore.rules` (`isAdmin()`), then deploy rules:
   ```bash
   npx firebase deploy --only firestore:rules,firestore:indexes,storage
   ```

The data model is revision-centric (`departments`, `compensation_plans`, `pay_steps`,
`submissions`, `confirmations`, `disputes`, `users`, `department_claims`). Rules enforce:
verified users publish without owner approval, and **no client can ever delete a
revision** — admins soft-remove via status only.

## Seed data — real DFW data is loaded

`data/departments.seed.json` is generated from your pay-plan sheet
(54 North-Texas departments) by:

```bash
node scripts/extract-links.js        # XLSX -> data/payplan-links.json (pay-plan URLs)
node scripts/import-sheet.js         # CSV + links -> departments.seed.json
npm run build                        # regenerate department/ranking pages
```

To refresh after editing the sheet, re-download **both** exports and rerun the three commands:
- `File → Download → CSV`  → `data/dfw-fire-pay.csv`
- `File → Download → Microsoft Excel (.xlsx)` → `data/dfw-fire-pay.xlsx`

The XLSX step exists only because CSV export strips the "Link to Pay Plan" hyperlink URLs;
`extract-links.js` recovers them so each department gets a real **"View pay plan ↗"** link.
To add departments from **other** regions, append rows in the same column layout (or hand-edit
`departments.seed.json` per `data/schema.md`).

Each sheet figure is treated as the published pay-plan **base** annual salary (the sheet has
no OT/incentive/transport/retirement breakdown, so those fields are intentionally left blank
for the community to fill in). Imported rows show **"Community reported / Current"** and gain
confidence as real contributors confirm them.

## Firestore reads & the community-consensus loop (low cost by design)

The public site (home, map, directory, department pages) reads **only static files** —
`departments.seed.json` + `overlay.json` served by Cloudflare's CDN. **Visitors perform 0
Firestore reads**, so read cost scales with contributions, not traffic or list size.

Community edits flow through Firestore without ever charging you per page view:

```
Contributor submits ──► Firestore `submissions` (a write)
                          │
        (scheduled job)   ▼
   npm run refresh  =  export-overlay.js ──► data/overlay.json  +  build-site.js ──► static pages
                          │
                          ▼
                 Visitors read static files only  →  0 Firestore reads
```

Run `npm run refresh` any time to pull the latest published submissions into the site.

- `js/aggregate.js` — pure merge/consensus logic (unit-tested), shared by the build and browser.
- `js/data.js` + `scripts/build-site.js` — merge `overlay.json` so map/directory/SEO reflect consensus.
- `scripts/export-overlay.js` — the exporter. Reads *published* submissions via the **public API key**
  (they're public-read per the rules), so it needs **no credentials** and runs anywhere. It's resilient:
  a transient Firestore error leaves the existing `overlay.json` in place and never breaks a build.
- `firebase-functions/` — **optional** `aggregate-on-write` Cloud Function that keeps a compact
  `department_summaries/{slug}` doc fresh, if you ever want *instant-live* department pages (flip
  `LIVE_OVERLAY` in `js/department.js`; costs ~1 read/view, edge-cacheable — still far cheaper than
  re-querying raw submissions).

**Automating it:** set the Cloudflare Pages build command to `npm run refresh` and trigger a scheduled
rebuild (a cron hitting the Pages deploy hook). Each rebuild re-pulls consensus from Firestore — no
secrets, because the read is public. This gets wired when the site is deployed.
- `firebase-functions/` — **optional** `aggregate-on-write` Cloud Function that keeps a compact
  `department_summaries/{slug}` doc fresh, if you ever want *instant-live* department pages (flip
  `LIVE_OVERLAY` in `js/department.js`; costs ~1 read/view, edge-cacheable — still far cheaper than
  re-querying raw submissions).

Rough scale: Firestore's free tier is 50k reads + 20k writes/day; with static serving, a million
page views ≈ 0 reads. You'd approach the limits only via thousands of sign-ins/submissions per day.

## Deploy (Cloudflare Pages)

- Build command: `npm run build` · Output directory: `.`
- `wrangler.jsonc` project name is a placeholder — confirm it (handoff #3).
- Generated pages/sitemap are regenerable; see `.gitignore` if you prefer to keep them out of git.

## What's built vs. scaffolded

**Working now:** homepage + search, interactive map (clustering, "Near me", "Search this
area", URL-synced filters), directory with the full filter/sort set, SEO department pages
(static + JSON-LD, hydrated from Firestore), comparison (up to 10, base/reported/hourly
toggles, incompatibility warnings), submission wizard (quick update / full pay plan / add
department / confirm / dispute), auth with email-verification gating, consensus + freshness
+ confidence labels, revision history, disclaimer everywhere, legal pages, admin overview.

**Scaffolded for a later pass** (data model + rules already accommodate): department-claim
verification flow, full admin moderation queues/merge/restore UI, reminder-email cron,
analytics dashboards, trusted-contributor auto-promotion, and revenue/sponsorship features.

## Design & product principles

Community-reported (never "verified" unless department-maintained) · base salary kept
separate from reported total compensation, with warnings on incompatible comparisons ·
history preserved as revisions · confidence/freshness shown with icon **and** label (never
color alone) · a distinct warm "Texas data atlas" identity — deliberately unlike the police
site's blue public-safety look.
