/*
 * functions/api/health.js — Example Cloudflare Pages Function.
 * GET /api/health -> { ok: true }
 * Server-side endpoints (source uploads, moderation webhooks, consensus jobs)
 * live under /functions and run at the edge. This is the scaffold to build on.
 */
export function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, service: 'texas-fire-salaries', time: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json' }
  });
}
