// Cloudflare Pages Function: POST /api/analytics
//
// First-party funnel collection. The site previously had no analytics at all,
// and the obvious fix — drop in a vendor tag — would have meant a third-party
// script, a CSP hole, an account, and visitor data leaving this account. This
// stores the same funnel in the owner's own D1 instead.
//
// What it deliberately does NOT record: IP address, user agent, member id,
// email, or anything else that identifies a person. `visit` is a random
// per-tab value the browser generates so the stages of one visit can be joined
// in a report; it is not stable across tabs, sessions or devices.
//
// The endpoint is public by necessity — measuring the funnel means measuring
// anonymous visitors, before any session exists — so it is written as a public
// write endpoint should be: rate limited, an allowlist of event names rather
// than free text, hard caps on every size, and no reflection of input back to
// the caller.

import { json, checkRateLimit } from './_lib/http.js';

// The funnel stages assets/funnel.js emits. An allowlist, not a filter: an
// unrecognized name is rejected outright, so this cannot become a general
// purpose write sink for anyone who finds the URL.
export const ALLOWED_EVENTS = new Set([
  'free_course_start',
  'lesson_expand',
  'lesson_complete',
  'free_level_complete',
  'lock_view',
  'plan_cta',
  'whop_checkout',
  'google_link',
  'core_to_complete_upgrade',
  'quiz_start',
  'quiz_complete',
  'lead_submit',
]);

const MAX_EVENTS_PER_BATCH = 25;
const MAX_PROPS_CHARS = 512;
const MAX_STRING_CHARS = 120;
const MAX_PROP_KEYS = 12;

/** Keep only small, primitive props; drop anything else rather than storing it. */
function sanitizeProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (keys >= MAX_PROP_KEYS) break;
    if (!/^[a-z0-9_]{1,32}$/i.test(k)) continue;
    let val;
    if (typeof v === 'string') val = v.slice(0, MAX_STRING_CHARS);
    else if (typeof v === 'number' && Number.isFinite(v)) val = v;
    else if (typeof v === 'boolean') val = v;
    else continue;                       // objects, arrays, null, functions
    out[k] = val;
    keys++;
  }
  if (!keys) return null;
  const encoded = JSON.stringify(out);
  return encoded.length > MAX_PROPS_CHARS ? null : encoded;
}

function cleanShort(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Strip control characters; keep it printable and bounded.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) || null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // A public write endpoint gets a tighter bucket than the public reads.
  const rl = await checkRateLimit(env, request, 'analytics', 120);
  if (!rl.allowed) return json({ ok: false, error: 'Too many requests.' }, 429);

  if (!env || !env.RESEARCH_DB) {
    // Say so rather than pretending to store: the client treats any non-2xx as
    // "drop it and move on", so an unconfigured deployment loses data quietly
    // in the browser instead of loudly on the page.
    return json({ ok: false, error: 'Analytics storage is not configured.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const events = Array.isArray(body && body.events) ? body.events : null;
  if (!events || !events.length) return json({ ok: false, error: 'No events.' }, 400);
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return json({ ok: false, error: 'Batch too large.' }, 400);
  }

  const visit = cleanShort(body.visit, 64);
  const rows = [];
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const name = typeof evt.name === 'string' ? evt.name : '';
    if (!ALLOWED_EVENTS.has(name)) continue;         // unknown stage: dropped
    rows.push({
      name,
      props: sanitizeProps(evt.props),
      visit,
      path: cleanShort(evt.path, 160),
    });
  }
  if (!rows.length) return json({ ok: true, stored: 0 }, 200);

  try {
    const stmt = env.RESEARCH_DB.prepare(
      'INSERT INTO analytics_events (name, props, visit_id, path) VALUES (?1, ?2, ?3, ?4)'
    );
    await env.RESEARCH_DB.batch(rows.map((r) => stmt.bind(r.name, r.props, r.visit, r.path)));
  } catch {
    // Never surface storage detail to an anonymous caller, and never let a
    // reporting failure look like a site failure.
    return json({ ok: false, error: 'Could not record events.' }, 502);
  }

  return json({ ok: true, stored: rows.length }, 200);
}
