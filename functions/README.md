# Cloudflare Functions (scaffold)

Server-side, edge-run endpoints for Texas Fire Salaries. Files here map to routes
automatically (`functions/api/health.js` → `/api/health`).

## Present
- `api/health.js` — liveness check.

## Phase 3 endpoints to add here (data model + rules already support them)
- `api/source-upload` — accept a source file, strip image metadata, store in R2/Storage, attach to a submission.
- `api/consensus-recompute` — service-account job that clusters `submissions`, promotes the current
  value into `compensation_plans` / `pay_steps`, and stamps `currentConsensusStatus`.
- `api/moderation-flag` — apply the automated flags (large jumps, out-of-range, rapid multi-department
  activity, profanity, PII, future dates, placeholder data) and set `status: 'flagged'`.
- `api/claim-verify` — compare a claim's email domain to the department/city website and auto-approve
  exact matches; otherwise enqueue for admin review.

## Scheduled reminders
Freshness reminder emails ("this department hasn't been updated recently — is it still current?")
run from a **Worker with a cron trigger** (Pages Functions aren't scheduled). See
`../workers/reminders/`.
