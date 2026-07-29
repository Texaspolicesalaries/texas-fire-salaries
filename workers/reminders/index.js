/*
 * workers/reminders/index.js — Scheduled reminder Worker (SCAFFOLD).
 *
 * Cron-triggered. When a department's information goes stale (12–18 months), email
 * previous contributors: "The salary information for this department has not been
 * updated recently. Do you know whether it is still current?" with a one-click
 * confirm link that records a confirmation after sign-in.
 *
 * This is a scaffold — wire it to Firestore (via REST + a service account) and an
 * email provider, then deploy with `wrangler deploy` from this folder.
 */
export default {
  async scheduled(event, env, ctx) {
    // 1. Query departments whose freshness bucket is 'update_recommended'.
    // 2. For each, find distinct prior contributors (respecting email privacy).
    // 3. Rate-limit and send the reminder with a signed one-click confirm link.
    // 4. Log sends to `email_log` for the admin dashboard.
    console.log('[reminders] scheduled run at', new Date(event.scheduledTime).toISOString());
  },
  async fetch() {
    return new Response('Texas Fire Salaries reminder worker. Runs on a cron schedule.', { status: 200 });
  }
};
