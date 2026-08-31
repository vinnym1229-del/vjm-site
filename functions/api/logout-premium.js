// Cloudflare Pages Function: POST /api/logout-premium
// Clears the premium session cookie. Idempotent.
//
// Uses verifySessionCookie (signature + expiry only), NOT getSession: signing
// out is not a gated request, and a member whose D1 record was just revoked
// must still get a clean, audited logout rather than being treated as having
// no session at all.

import { verifySessionCookie } from './_lib/session.js';
import { jsonClearedSession } from './_lib/http.js';

export async function onRequestPost(context) {
  try {
    const session = await verifySessionCookie(context.request, context.env);
    if (session && (context.env.RATELIMIT_DB || context.env.RESEARCH_DB)) {
      const db = context.env.RATELIMIT_DB || context.env.RESEARCH_DB;
      try {
        await db.prepare('INSERT INTO audit_events (event_type, outcome, subject_hash) VALUES (?1, ?2, ?3)')
          .bind('logout', 'ok', String(session.mr || '').slice(0, 16))
          .run();
      } catch { /* best-effort */ }
    }
  } catch { /* never block logout */ }
  return jsonClearedSession({ ok: true });
}
