# Owner's guide — running Texas Fire Salaries without a developer

Everything in this file is doable with the admin panel, a text editor, and the
commands shown. None of it requires writing code. The last section says when you
*do* want a developer (or a Claude session — the project keeps memory, so
"Prosper FD has the same academy-pay issue Anna had" is a one-message fix).

## How you find out something needs you

You don't have to check the site. Every few minutes, CI looks at the moderation
queues and maintains a single GitHub issue labeled **`queue-alert`**:

- Issue opened, or a new comment → GitHub emails you (keep the repo on
  **Watch → All activity** to guarantee delivery).
- It lists flagged submissions, open disputes, and submissions from the last
  3 days, each linking into the admin panel.
- It closes itself when everything is handled.

Pending **claims** can't be watched this way (they're private by design) — glance
at the Claims tab when you're in the panel.

## The admin panel — <https://texasfiresalaries.com/admin>

| Tab | What's there |
|---|---|
| Overview | Site health, what needs attention, last-24h snapshot |
| Activity | Searches (incl. what people looked for and didn't find), views, per-day charts, recent submissions with before→after diffs |
| Moderation | Flagged submissions (full diffs + evidence link), disputes, duplicates, location checks, suspensions |
| Claims | Department-ownership requests and active claims |
| Data tools | Your correction tools — see below |

## Recipe 1 — a figure on a page is wrong

**Admin → Data tools → Field locks & corrections.** Pick the department and field,
enter the right amount, add a short public note (it shows on the history card).

- Leave **Lock** unchecked for a normal correction: it wins now, but future
  community reports can supersede it naturally. This is almost always right.
- Check **Lock** only when the value must stay pinned no matter what people
  submit. Unlock it later from the same card.

Takes effect on the next automatic refresh (minutes). Never edit or delete a
contributor's submission — the history is append-only on purpose.

## Recipe 2 — new pay plans / updating the sheet

The Google Sheet is the source of truth for baseline data.

1. Update the sheet.
2. Download it as CSV over `data/dfw-fire-pay.csv` (File → Download → CSV).
3. From the project folder:

```bash
node scripts/import-sheet.js
```

4. Commit and push to `main` — CI rebuilds and deploys on its own.

Owner corrections in `data/seed-overrides.json` (Recipe 3) are re-applied on
every import automatically. Seed edits update the "Official pay-plan import"
baseline in place — they don't create history entries.

## Recipe 3 — a pay plan's first-year figure is really academy/recruit pay

Symptom: the page's entry pay disagrees with the step table's first row, and a
warning note appears under the table (this was Anna FD). Fix: open
`data/seed-overrides.json` and add one line under `"overrides"`:

```json
"some-dept-slug": { "firstStepIsRecruit": true }
```

(The slug is the department's URL name, e.g. `/departments/anna-fd/` → `anna-fd`.)
Then run Recipe 2's import + push. The importer moves that first figure to the
standalone "Recruit pay" card and the table starts at the true entry step.

## Recipe 4 — publishing manually when CI is down

```bash
npm run publish-now
```

Runs refresh → tests → Cloudflare deploy. The refresh step is **not** optional —
skipping it would deploy a stale overlay and wipe live community data off the site.

## Console settings that exist outside this repo (don't lose them)

- **Cloudflare** → Caching → Configuration → Browser Cache TTL =
  **"Respect Existing Headers"** (otherwise visitors keep stale JS for hours).
- **Firestore TTL policy**: collection group `events`, field `expiresAt`
  (Google Cloud console → Firestore → Time-to-live). Makes analytics
  self-delete at ~90 days; the panel's Daily history card preserves the trend.
- **Firebase Auth admin list** also lives in `js/auth.js` + `firestore.rules`
  (`ADMIN_EMAILS`) — changing admins is a developer task, see below.

## When to bring in a developer / Claude

- Anything touching **`firestore.rules`** — it's the security boundary; a wrong
  line silently opens or breaks submissions.
- A data problem `seed-overrides.json` has no switch for yet (new override
  types are small code changes).
- New features, new form fields (fields must survive six pipeline hops — this
  codebase's recurring bug), UI changes, CI/notifier changes.

Rule of thumb: if the fix is "this number/label is wrong," you have a tool for
it. If the fix is "the site should *behave* differently," bring help.
