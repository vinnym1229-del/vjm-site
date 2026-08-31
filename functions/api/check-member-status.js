// Cloudflare Pages Function: GET /api/check-member-status?discord=<handle>
//
// Public membership lookup used by the homepage status widget.
// Hardened: rate limited, generic responses that do not reveal whether a
// handle exists on the sheet vs is inactive, no upstream error leakage.
//
// D1 is the authority (migration 0006). The owner's Google Sheet is a
// human-maintained mirror that lags behind cancellations, so a whop_codes row
// that says revoked or expired wins outright and the bridge is never asked.
// The Sheet is consulted only when D1 has nothing on this handle — a member
// who predates whop_codes — and then only to say "yes".

import { checkRateLimit } from './_lib/http.js';
import { entitlementRowState } from './_lib/session.js';

const GENERIC = 'Membership status for this Discord handle is not currently active.';

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch {
    return json({ ok: false, error: 'Status lookup is temporarily unavailable.' }, 502);
  }
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const raw = (url.searchParams.get('discord') || '').trim().toLowerCase().replace(/^@+/, '');

  if (!raw || !/^[a-z0-9._-]{2,32}$/.test(raw)) {
    return json({ ok: false, error: 'Enter a valid Discord username.' }, 400);
  }

  const limit = await checkRateLimit(env, request, 'member-status', 8, raw.slice(0, 16));
  if (!limit.allowed) {
    return json({ ok: false, error: 'Too many lookups. Wait a minute and try again.' }, 429);
  }

  // Configured means "at least one authority is reachable": D1, or the Sheet
  // bridge. A D1-only deployment is the end state once the Sheet is retired.
  if (!env.RESEARCH_DB && !env.MEMBERS_STATUS_URL && !(env.MEMBERS_BRIDGE_URL && env.MEMBERS_BRIDGE_SECRET)) {
    return json({ ok: false, error: 'Status lookup is not configured.' }, 503);
  }

  let active = false;
  try {
    active = await lookupActive(env, raw);
  } catch {
    return json({ ok: false, error: 'Status lookup is temporarily unavailable.' }, 502);
  }

  // Same generic response whether the handle is unknown or inactive.
  return json({
    ok: true,
    discord: raw,
    active,
    message: active ? 'Active membership found.' : GENERIC,
    checkedAt: new Date().toISOString(),
  }, active ? 200 : 404);
}

async function lookupActive(env, handle) {
  const d1 = await lookupD1(env, handle);
  // A definite answer from D1 — live OR dead — ends the lookup. Falling
  // through to the Sheet on a "dead" answer is exactly how a canceled member
  // kept showing as active.
  if (d1 !== null) return d1;
  return lookupViaSheet(env, handle);
}

// Returns true/false when D1 has a record for this handle, or null when it
// has nothing to say (no binding, no rows, or an outage — an outage must not
// be read as "not a member", so it defers to the bridge instead).
async function lookupD1(env, handle) {
  if (!env.RESEARCH_DB) return null;
  let rows;
  try {
    rows = await env.RESEARCH_DB.prepare(
      `SELECT status, expires_at, session_epoch FROM whop_codes
       WHERE lower(discord) = ?1 ORDER BY created_at DESC LIMIT 10`
    ).bind(handle).all();
  } catch {
    return null;
  }
  const results = rows && Array.isArray(rows.results) ? rows.results : [];
  if (results.length === 0) return null;
  const now = Date.now();
  return results.some((row) => entitlementRowState(row, now).live);
}

async function lookupViaSheet(env, handle) {
  if (!env.MEMBERS_STATUS_URL && !(env.MEMBERS_BRIDGE_URL && env.MEMBERS_BRIDGE_SECRET)) return false;
  if (env.MEMBERS_BRIDGE_URL && env.MEMBERS_BRIDGE_SECRET) {
    const record = await bridgeLookup(env, { type: 'discord', value: handle });
    if (!record) return false;
    const status = String(record.status || '').toLowerCase();
    return status === 'active' || status === 'renewed';
  }
  const res = await fetch(String(env.MEMBERS_STATUS_URL), {
    cf: { cacheTtl: 15, cacheEverything: true },
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) throw new Error('bridge');
  const status = String((data.statuses || {})[handle] || '').toLowerCase();
  return status === 'active' || status === 'renewed';
}

async function bridgeLookup(env, query) {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const bodyJson = JSON.stringify(query);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(env.MEMBERS_BRIDGE_SECRET)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}\n${nonce}\n${bodyJson}`)
  );
  const mac = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(String(env.MEMBERS_BRIDGE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, nonce, payload: bodyJson, mac }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('bridge');
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true || !data.found) return null;
  return data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
