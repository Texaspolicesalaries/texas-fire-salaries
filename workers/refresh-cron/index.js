/*
 * refresh-cron — Cloudflare Worker that triggers the site's scheduled refresh.
 *
 * On its cron schedule it POSTs to the Cloudflare Pages **deploy hook**, which
 * kicks off a Pages build. That build runs `npm run refresh` (export the latest
 * Firestore consensus into overlay.json, then rebuild), so the public site picks
 * up community edits automatically — with no secrets (the Firestore read is public).
 *
 * Setup:
 *   1. Create the Pages project (build command: `npm run refresh`).
 *   2. Pages → Settings → Builds & deployments → Deploy hooks → create one, copy the URL.
 *   3. wrangler secret put PAGES_DEPLOY_HOOK   (paste that URL)
 *   4. wrangler deploy   (from this folder)
 * Change the cadence in wrangler.toml ([triggers].crons).
 */
export default {
  async scheduled(event, env, ctx) {
    if (!env.PAGES_DEPLOY_HOOK) {
      console.error('[refresh-cron] PAGES_DEPLOY_HOOK secret is not set — nothing to trigger.');
      return;
    }
    const res = await fetch(env.PAGES_DEPLOY_HOOK, { method: 'POST' });
    console.log('[refresh-cron] triggered Pages rebuild at', new Date(event.scheduledTime).toISOString(), '→ HTTP', res.status);
  },

  // A plain GET lets you trigger a refresh on demand (visit the worker URL).
  async fetch(request, env) {
    if (!env.PAGES_DEPLOY_HOOK) return new Response('PAGES_DEPLOY_HOOK not configured', { status: 500 });
    const res = await fetch(env.PAGES_DEPLOY_HOOK, { method: 'POST' });
    return new Response('Refresh triggered → HTTP ' + res.status + '\n');
  }
};
