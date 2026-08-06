# Seed data import format

`departments.seed.json` is the **directory backbone** of the site: it defines which
departments exist, where they are on the map, and their structured attributes. Live
community salary submissions are layered on top from Firestore at runtime — but the
seed can also carry *illustrative* starter salary data (the `salary` block) so pages
render before Firebase is connected.

When you send your real Texas fire department list / DFW Fire Salaries historical
export, match it to this shape (CSV/Sheet is fine — we map columns to these keys).

## Top level

```jsonc
{
  "meta":    { "source": "...", "generated": "YYYY-MM-DD", "note": "...", "disclaimer": "..." },
  "regions": [ { "id": "north-texas", "name": "North Texas (DFW)" } ],
  "departments": [ /* see below */ ]
}
```

## Department object

| Key | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | ✅ | URL id, kebab-case, unique. Becomes `/departments/<slug>/`. |
| `name` | string | ✅ | Official department name. |
| `city` | string | ✅ | |
| `county` | string | ✅ | County name, no "County" suffix. |
| `region` | string | ✅ | Must match a `regions[].id`. |
| `zip` | string | ✅ | 5-digit. Powers ZIP-radius filters. |
| `lat` / `lng` | number | ✅ | Decimal degrees. Powers the map. |
| `departmentType` | enum | ✅ | `municipal` \| `esd` \| `county` \| `university` \| `airport` \| `fire-rescue-district` \| `combination` \| `other` |
| `website` | string(URL) | | |
| `careersUrl` | string(URL) | | |
| `phone` | string | | |
| `stations` | number | | |
| `transportStatus` | enum | | `transport` \| `non-transport` \| `unknown` |
| `civilService` | boolean | | |
| `retirementSystem` | string | | e.g. `TMRS`, `HFRRF`, local pension abbreviation. |
| `hiringStatus` | enum | | `hiring` \| `not-hiring` \| `unknown` |
| `scheduleType` | string | | `24/48` \| `48/96` \| `24/72` \| `40-hour` \| custom. |
| `annualScheduledHours` | number | | Used for effective-hourly math (defaults from schedule if omitted). |
| `flags` | object | | Booleans below — power filter checkboxes. |
| `departmentMaintained` | boolean | | True only for pages an official dept account manages. |
| `dataStatus` | enum | | `none` (no salary yet) \| `historical` (restored/starter) \| `current`. |
| `salary` | object | | Optional embedded starter compensation — see below. |

### `flags`
`paramedicIncentive`, `certPay`, `educationPay`, `longevity`, `lateralsAccepted`,
`emtRequired`, `paramedicRequired` — all boolean.

## `salary` object (optional starter data)

```jsonc
{
  "effectiveDate": "YYYY-MM-DD",
  "includesScheduledOvertime": false,   // keep base vs total-comp honest
  "includesFlsaOvertime": false,
  "sourceType": "official-pay-plan | collective-bargaining | meet-and-confer | community | other",
  "sourceUrl": "https://...",
  "classification": "Firefighter | Firefighter-Paramedic | ...",
  "recruitPay": 52000,   // optional — pay during the academy, BEFORE graduating to
                          // Firefighter. Independent of steps[] below; never used
                          // for entry/top/years-to-top or any ranking/comparison.
  "steps": [
    {
      "stepName": "Firefighter",
      "minimumMonths": 12, "maximumMonths": 36,   // maximumMonths null = open-ended top step
      "classification": "Firefighter",
      "baseAnnualSalary": 60000,
      "scheduledOvertime": 0,
      "paramedicPay": 6000,
      "certificationPay": 0, "educationPay": 0, "longevityPay": 0, "otherFixedPay": 0,
      "reportedAnnualCompensation": 66000
    }
  ],
  "reports": [
    // Pseudo-submissions that let the consensus engine compute confidence + freshness
    // in the static demo. In production these come from the Firestore `submissions`
    // collection instead. Safe to omit.
    { "contributorId": "u_1", "submittedAt": "YYYY-MM-DD", "entry": 60000, "top": 82000,
      "medic": 8500, "hasSource": true, "departmentMaintained": false }
  ]
}
```

### Rules the app relies on
- **Never mix base and total comp.** `baseAnnualSalary` is base only; scheduled OT,
  paramedic pay, etc. are separate columns; `reportedAnnualCompensation` is the sum the
  submitter reported. The UI always shows which is which.
- **`recruitPay` is never the first step.** `steps[0]` should always be the first
  Firefighter step (what drives "entry pay," rankings, and career-earnings math). A
  department's academy/recruit stipend — often lower, temporary, and not part of the
  Firefighter pay scale — belongs in the standalone `recruitPay` field instead, so it
  can be shown for context (the "Recruit pay" card) without skewing entry pay or
  comparisons against departments that only report the post-graduation rate.
- **Steps ordered by `minimumMonths`.** The step in effect at the start of a service
  year is used for that year's earnings (documented on the page).
- **`maximumMonths: null`** marks the open-ended top step (career-earnings carry-forward
  only "assumes" continuation when the *final* step is bounded).
- Any `salary` embedded here is starter/historical data and is labeled
  "Historical data — current information requested" until the community updates it.

## Minimal CSV → JSON

A directory-only CSV with these columns imports cleanly (salary added later via the site):

```
slug,name,city,county,region,zip,lat,lng,departmentType,website,careersUrl,phone,stations,transportStatus,civilService,retirementSystem,hiringStatus,scheduleType
```
