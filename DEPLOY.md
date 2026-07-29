# Deploy + automatic refresh (git-connected Cloudflare Pages)

Goal: host the site on Cloudflare Pages and have it **refresh community data automatically**
on a schedule. No secrets are needed for the refresh (Firestore published data is public-read).

## 1. Put the code on GitHub

```bash
cd "/Users/alan/Documents/Website/TexasFireSalaries"
git init
git add -A
git commit -m "Texas Fire Salaries — initial"
# create the repo (private) and push; needs the GitHub CLI signed in, or do it in the browser:
gh repo create texas-fire-salaries --private --source=. --push
```
Nothing sensitive is committed — the Firebase web config is public by design, and there's no
service-account key. (`.gitignore` also blocks any `*-firebase-adminsdk-*.json` just in case.)

## 2. Connect Cloudflare Pages to the repo

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick
`texas-fire-salaries`, then set:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm run refresh` |
| Build output directory | `/` (repo root) |
| Environment variable | `NODE_VERSION` = `20` |

**Save and Deploy.** `npm run refresh` = export the latest Firestore consensus into
`overlay.json`, then build all pages. (`.nvmrc` also pins Node 20.)

## 3. Point auth at the real domain

Once you have the Pages URL (or a custom domain like `texasfiresalaries.com`):
Firebase Console → **Authentication → Settings → Authorized domains → Add domain** → add it.
(Google sign-in only works on authorized domains; `localhost` is already allowed for dev.)

## 4. Create a deploy hook (the thing the schedule pings)

Pages project → **Settings → Builds & deployments → Deploy hooks → Add** → name it
`scheduled-refresh` → copy the URL it gives you.

## 5. Turn on the schedule (the refresh worker)

```bash
cd "/Users/alan/Documents/Website/TexasFireSalaries/workers/refresh-cron"
npx wrangler secret put PAGES_DEPLOY_HOOK      # paste the deploy-hook URL from step 4
npx wrangler deploy
```
Default cadence is **hourly** — change it in `workers/refresh-cron/wrangler.toml`
(`[triggers].crons`). You can also POST to the deploy hook (or visit the worker URL) to force a
refresh on demand.

## How it flows after this

```
contributor submits → Firestore (write)
hourly: refresh worker → pings deploy hook → Pages build runs `npm run refresh`
        → export-overlay reads Firestore (public) → overlay.json → rebuild → redeploy
visitors → static files only → 0 Firestore reads
```

Changing site code = `git push` (Pages auto-builds). Changing data = happens automatically on the
schedule, or trigger the deploy hook anytime.
