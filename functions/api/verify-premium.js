// Cloudflare Pages Function: /api/verify-premium
//
// POST /api/verify-premium   { "code": "XXXX-1234" }
//   Validates a member access code against the owner's member bridge
//   (Apps Script). On success issues an HttpOnly session cookie.
//   The token is NEVER returned in the response body or accepted via URL.
//
// GET /api/verify-premium
//   Returns the current session state from the session cookie only.
//   Used by pages to restore "already signed in" state on load.
//
// Env vars:
//   SESSION_SIGNING_SECRET   required (>=32 chars) dedicated signing key
//   LEGACY_ALLOW_CODES_AS_KEY optional "true" migration escape hatch
//   MEMBERS_STATUS_URL       legacy full-map bridge URL (deprecated)
//   MEMBERS_BRIDGE_URL       new authenticated single-record bridge URL
//   MEMBERS_BRIDGE_SECRET    shared secret for the authenticated bridge
//   SESSION_DAYS             optional session lifetime (default 7, max 30)
//   RESEARCH_DB              optional D1; holds whop_codes.tier (migration 0005)
//
// The issued session carries a signed tier claim (`t`) so the middleware and
// the paid APIs can tell a $100 Futures member from a $129 Complete member.

import {
  resolveSigningSecret, signSession, getSession, sessionDays,
} from './_lib/session.js';
import { json, jsonWithSession, checkRateLimit } from './_lib/http.js';
import { turnstileConfigured, verifyTurnstile } from './_lib/turnstile.js';
import { SESSION_VERSION, isTier, resolveTier } from './_lib/entitlements.js';

const GENERIC_BAD_CODE = 'We could not activate this code. Check it and try again, or DM St1101 on Discord.';

export async function onRequestPost(context) {
  try { return await handlePost(context); }
  catch { return json({ ok: false, error: 'Service temporarily unavailable.' }, 500); }
}

export async function onRequestGet(context) {
  try { return await handleGet(context); }
  catch { return json({ ok: false, error: 'Service temporarily unavailable.' }, 500); }
}

async function handlePost(context) {
  const { request, env } = context;

  const limit = await checkRateLimit(env, request, 'verify', 10);
  if (!limit.allowed) {
    return json({ ok: false, error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }

  const secret = resolveSigningSecret(env);
  if (!secret) {
    // Fail closed: never sign sessions with improvised key material.
    return json({ ok: false, error: 'Sign-in is not configured. Contact the admin.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  const code = String((body && body.code) || '').trim().toUpperCase().slice(0, 64);
  if (!code || code.length > 64 || !/^[A-Z0-9-]{4,64}$/.test(code)) {
    return json({ ok: false, error: GENERIC_BAD_CODE }, 401);
  }

  // Only enforced once the owner sets TURNSTILE_SECRET_KEY — see
  // _lib/turnstile.js for why this stays soft-required until then.
  if (turnstileConfigured(env)) {
    const token = String((body && body.turnstileToken) || '');
    const ip = request.headers.get('CF-Connecting-IP') || undefined;
    const human = await verifyTurnstile(env, token, ip);
    if (!human) {
      await auditEvent(env, 'verify_code', 'bot_check_failed', code);
      return json({ ok: false, error: 'Verification failed. Refresh the page and try again.' }, 401);
    }
  }

  const record = await lookupByCode(env, code);
  if (!record) {
    // One generic message for unknown code AND inactive member: prevents
    // probing the sheet for which codes exist.
    await auditEvent(env, 'verify_code', 'rejected', code);
    return json({ ok: false, error: GENERIC_BAD_CODE }, 401);
  }

  const days = sessionDays(env);
  const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
  const memberRef = await memberRefFor(code);
  const tier = await tierForCode(env, code);
  const token = await signSession(
    { v: SESSION_VERSION, mr: memberRef, dn: record.discord || '', t: tier, exp: expiresAt },
    secret
  );
  await auditEvent(env, 'verify_code', 'granted', code);

  return jsonWithSession(
    { ok: true, expiresAt: new Date(expiresAt).toISOString(), discord: record.discord || null },
    token,
    days * 24 * 60 * 60
  );
}

async function handleGet(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) {
    return json({ ok: true, active: false }, 200);
  }
  return json({
    ok: true,
    active: true,
    discord: session.dn || null,
    expiresAt: new Date(Number(session.exp)).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tier resolution for a code
// ---------------------------------------------------------------------------

// The whop-webhook records the tier it resolved on the whop_codes row keyed
// by SHA-256 of the code (migration 0005), so a code minted by a Whop
// purchase carries its real product's tier.
//
// A code that has no D1 row is a legacy member: the owner's Google Sheet
// predates whop_codes entirely, and the member bridge above just confirmed
// they are active and paying. Locking them out because we cannot name their
// product would break live customers, so they get resolveTier's
// *unconfigured default* — the same tier this site granted everyone before
// tiers existed (WHOP_DEFAULT_TIER, else 'complete'). Passing an env with no
// allowlists forces that branch deliberately: the allowlists are for
// classifying Whop products, and a Sheet-only member has no product id to
// classify, so 'not_allowlisted' would be the wrong answer, not a safer one.
async function tierForCode(env, code) {
  const fallback = resolveTier({ WHOP_DEFAULT_TIER: env && env.WHOP_DEFAULT_TIER }, {}).tier;
  if (!env || !env.RESEARCH_DB) return fallback;
  try {
    const hash = await sha256Hex(code);
    const row = await env.RESEARCH_DB
      .prepare('SELECT tier FROM whop_codes WHERE code_hash = ?1 LIMIT 1')
      .bind(hash).first();
    if (row && isTier(row.tier)) return row.tier;
  } catch {
    // Tier lookup is best-effort: a D1 outage must not lock out a member the
    // bridge already verified. Fall back rather than fail the sign-in.
  }
  return fallback;
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Member bridge access. Two modes:
//  1) Authenticated single-record bridge (preferred): MEMBERS_BRIDGE_URL +
//     MEMBERS_BRIDGE_SECRET. Server-to-server signed lookup; returns one row.
//  2) Legacy full-map bridge (deprecated): MEMBERS_STATUS_URL. Kept ONLY so
//     the site keeps working while the owner migrates the sheet. Never
//     exposed to browsers; scheduled for removal (see APPS-SCRIPT-INTEGRATION).
// ---------------------------------------------------------------------------

async function lookupByCode(env, code) {
  if (env.MEMBERS_BRIDGE_URL && env.MEMBERS_BRIDGE_SECRET) {
    return lookupViaSecureBridge(env, { type: 'code', value: code });
  }
  if (env.MEMBERS_STATUS_URL) {
    return lookupViaLegacyBridge(env, (data) => {
      const entry = (data.codes || {})[code];
      if (!entry) return null;
      const status = String(entry.status || '').toLowerCase();
      if (status !== 'active' && status !== 'renewed') return null;
      return { discord: entry.discord || '' };
    });
  }
  return null;
}

async function lookupViaSecureBridge(env, query) {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const bodyJson = JSON.stringify(query);
  const mac = await bridgeMac(env.MEMBERS_BRIDGE_SECRET, timestamp, nonce, bodyJson);
  let res;
  try {
    res = await fetch(String(env.MEMBERS_BRIDGE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp, nonce, payload: bodyJson, mac }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error('bridge unreachable'), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error('bridge error'), { status: 502 });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true || !data.found) return null;
  const status = String(data.status || '').toLowerCase();
  if (status !== 'active' && status !== 'renewed') return null;
  return { discord: String(data.discord || '') };
}

async function bridgeMac(secret, timestamp, nonce, bodyJson) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const msg = `${timestamp}\n${nonce}\n${bodyJson}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function lookupViaLegacyBridge(env, pick) {
  let res;
  try {
    res = await fetch(String(env.MEMBERS_STATUS_URL), {
      cf: { cacheTtl: 15, cacheEverything: true },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error('bridge unreachable'), { status: 502 });
  }
  const text = await res.text().catch(() => '');
  let data;
  try { data = JSON.parse(text); } catch { 
    throw Object.assign(new Error('bridge returned invalid JSON'), { status: 502 });
  }
  if (!data || data.ok !== true) {
    throw Object.assign(new Error('bridge rejected request'), { status: 502 });
  }
  return pick(data);
}

async function memberRefFor(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vjm-member:' + code));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function auditEvent(env, type, outcome, subject) {
  if (!env.RATELIMIT_DB && !env.RESEARCH_DB) return;
  const db = env.RATELIMIT_DB || env.RESEARCH_DB;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject));
    const hash = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
    await db.prepare(
      'INSERT INTO audit_events (event_type, outcome, subject_hash) VALUES (?1, ?2, ?3)'
    ).bind(type, outcome, hash).run();
  } catch {
    // Audit is best-effort; never block auth on logging failure.
  }
}

// Exported for contract tests.
export { GENERIC_BAD_CODE };
