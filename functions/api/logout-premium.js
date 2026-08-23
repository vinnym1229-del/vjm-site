// Cloudflare Pages Function: POST /api/logout-premium
// Clears the premium session cookie. Idempotent.

import { getSession } from '../_lib/session.js';
import { jsonClearedSession } from '../_lib/http.js';

export async function onRequestPost(context) {
  try {
    const session = await getSession(context.request, context.env);
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
