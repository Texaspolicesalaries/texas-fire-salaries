/*
 * refresh-cron — Cloudflare Worker that keeps the public site in step with
 * Firestore, by running the schedule GitHub will not run reliably.
 *
 * WHY THIS EXISTS
 * The refresh is done by the "Refresh salary data" GitHub Actions workflow,
 * which declares `cron: "*\/5 * * * *"`. GitHub does not honour that. Measured
 * on 2026-08-06/07, scheduled runs actually landed every two to three HOURS,
 * and twice failed after 15 minutes with "The job was not acquired by Runner of
 * type hosted" — GitHub throttles high-frequency schedules and drops them under
 * load. Every fast refresh in the run history came from a push, so on a quiet
 * day (submissions arriving, no commits) two newly added departments stayed
 * invisible for hours while the submit form promised "a few minutes".
 *
 * Cloudflare's cron triggers do fire on time, so the SCHEDULE lives here while
 * GitHub keeps doing the WORK: this dispatches the same workflow (it already
 * declares workflow_dispatch), which refreshes overlay.json from Firestore,
 * runs the tests, and deploys to Pages.
 *
 * It deliberately does NOT call a Pages deploy hook, which is what the first
 * version of this file did: the Pages project is direct-upload (Git Provider:
 * No), so Cloudflare never builds it and there is no deploy hook to call. That
 * mismatch is why this Worker sat in the repo undeployed.
 *
 * SETUP (once)
 *   1. GitHub → Settings → Developer settings → Personal access tokens →
 *      Fine-grained tokens. Repository access: only texas-fire-salaries.
 *      Permissions: Actions = Read and write. Nothing else.
 *   2. cd workers/refresh-cron && npx wrangler secret put GITHUB_TOKEN
 *      (paste the token at the prompt — it is never stored in this repo)
 *   3. npx wrangler deploy
 *   Optional, to enable the on-demand URL:
 *      npx wrangler secret put TRIGGER_KEY
 *
 * Cadence lives in wrangler.toml ([triggers].crons).
 */

const GITHUB_API = 'https://api.github.com';

async function dispatchWorkflow(env) {
  if (!env.GITHUB_TOKEN) {
    return { ok: false, status: 0, detail: 'GITHUB_TOKEN secret is not set' };
  }
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API requests that don't send one.
      'User-Agent': 'texas-fire-salaries-refresh-cron'
    },
    body: JSON.stringify({ ref: env.GIT_REF || 'main' })
  });
  // This endpoint answers 204 No Content on success — anything else is a failure
  // worth reading, so the body is kept for the log rather than discarded.
  if (res.status === 204) return { ok: true, status: 204, detail: '' };
  return { ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
}

export default {
  async scheduled(event, env) {
    const r = await dispatchWorkflow(env);
    if (r.ok) {
      console.log('[refresh-cron] dispatched refresh at', new Date(event.scheduledTime).toISOString());
    } else {
      // Loud on purpose: a silent failure here looks exactly like the problem
      // this Worker exists to fix — a site that quietly stops updating.
      console.error('[refresh-cron] dispatch FAILED — HTTP', r.status, r.detail);
    }
  },

  // On-demand trigger, for when something needs to go live right now. Gated by
  // a shared key: an open URL would let anyone spin the deploy pipeline. With
  // no TRIGGER_KEY set the endpoint simply does not exist — 404 rather than 403
  // so it isn't advertised to anyone probing.
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get('key');
    if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
      return new Response('Not found\n', { status: 404 });
    }
    const r = await dispatchWorkflow(env);
    return new Response((r.ok ? 'Refresh dispatched.' : 'Dispatch failed: ' + r.detail) + '\n',
      { status: r.ok ? 200 : 502 });
  }
};
