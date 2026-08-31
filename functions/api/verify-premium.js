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
//   RESEARCH_DB              D1; holds whop_codes (migrations 0003-0006)
//
// SOURCE OF TRUTH (migration 0006). D1 is checked FIRST and its answer is
// final — including its refusals. Only when D1 has nothing to say about a
// code (no row, no binding, or an outage) does the owner's Google Sheet
// bridge get consulted, and then only to say "yes". That ordering is the
// whole point: a code the Whop webhook has revoked must stay dead even while
// the Sheet still lists the member as Active, and a code the webhook just
// minted must work immediately without anyone copying it into the Sheet.
//
// The issued session carries a signed tier claim (`t`) so the middleware and
// the paid APIs can tell a $100 Futures member from a $129 Complete member,
// plus `sv` (the member's session epoch) and `src` (which authority granted
// it) so the entitlement check in _lib/session.js can kill it mid-flight.

import {
  resolveSigningSecret, signSession, getSession, sessionDays,
  loadEntitlementByCodeHash, entitlementRowState, memberRefFromCodeHash,
  SESSION_SOURCE,
} from './_lib/session.js';
import { json, jsonWithSession, checkRateLimit } from './_lib/http.js';
import { turnstileConfigured, verifyTurnstile } from './_lib/turnstile.js';
import { SESSION_VERSION, isTier, resolveTier, sessionTier } from './_lib/entitlements.js';

const GENERIC_BAD_CODE = 'We could not activate this code. Check it and try again, or DM St1101 on Discord.';

// A distinct message is safe here and only here: to see it you must already
// possess a code we issued, so it reveals nothing an attacker could enumerate
// — and telling a lapsed customer "renew" instead of "check your code" is the
// difference between a renewal and a support ticket.
const MEMBERSHIP_ENDED = 'That membership is no longer active. Renew on Whop, or DM St1101 on Discord if you think this is wrong.';

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

  const codeHash = await sha256Hex(code);
  const memberRef = memberRefFromCodeHash(codeHash);
  const days = sessionDays(env);
  const cap = Date.now() + days * 24 * 60 * 60 * 1000;

  // ── 1. D1 first, and its refusals are final ─────────────────────────────
  const d1 = await loadEntitlementByCodeHash(env, codeHash);
  if (d1.ok && d1.row) {
    const state = entitlementRowState(d1.row);
    if (!state.live) {
      // Revoked, expired, or never delivered. Do NOT fall through to the
      // Sheet: the Sheet is a human-maintained mirror that lags behind
      // cancellations, and consulting it here is precisely how a canceled
      // customer used to keep their access.
      await auditEvent(env, 'verify_code', 'denied_' + state.reason, code);
      const expiredish = state.reason === 'expired' || state.reason === 'revoked';
      return json({ ok: false, error: expiredish ? MEMBERSHIP_ENDED : GENERIC_BAD_CODE }, expiredish ? 403 : 401);
    }
    // Honour the plan's own expiry, but never mint a token that outlives the
    // session cap (a yearly plan must not become a year-long bearer token).
    const expiresAt = state.expiresAt === null ? cap : Math.min(state.expiresAt, cap);
    const token = await signSession(
      {
        v: SESSION_VERSION,
        mr: memberRef,
        dn: d1.row.discord || '',
        t: isTier(d1.row.tier) ? d1.row.tier : unconfiguredDefaultTier(env),
        sv: state.epoch,
        src: SESSION_SOURCE.D1,
        exp: expiresAt,
      },
      secret
    );
    await auditEvent(env, 'verify_code', 'granted_d1', code);
    return jsonWithSession(
      { ok: true, expiresAt: new Date(expiresAt).toISOString(), discord: d1.row.discord || null },
      token,
      Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
    );
  }

  // ── 2. Sheet bridge fallback (migration path only — see RETIRING THE SHEET) ──
  const record = await lookupByCode(env, code);
  if (!record) {
    // One generic message for unknown code AND inactive member: prevents
    // probing the sheet for which codes exist.
    await auditEvent(env, 'verify_code', 'rejected', code);
    return json({ ok: false, error: GENERIC_BAD_CODE }, 401);
  }

  const expiresAt = cap;
  const token = await signSession(
    {
      v: SESSION_VERSION,
      mr: memberRef,
      dn: record.discord || '',
      t: unconfiguredDefaultTier(env),
      sv: 0,
      src: SESSION_SOURCE.SHEET,
      exp: expiresAt,
    },
    secret
  );
  await auditEvent(env, 'verify_code', 'granted_sheet', code);

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
  // The tier is part of the answer, not an implementation detail. Without it
  // the client can only INFER "signed in but under-tier" from the middleware's
  // data-locked stamp on the stripped content — which conflates a member who
  // needs to upgrade with one whose page simply failed to load. Returning the
  // signed claim makes the upgrade prompt a fact rather than a deduction.
  return json({
    ok: true,
    active: true,
    tier: sessionTier(session, env),
    discord: session.dn || null,
    expiresAt: new Date(Number(session.exp)).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Tier resolution for a Sheet-only member
// ---------------------------------------------------------------------------

// A code with a whop_codes row carries the tier the webhook resolved at
// purchase time; that is read inline above.
//
// A code with NO D1 row is a legacy member: the owner's Google Sheet predates
// whop_codes entirely, and the member bridge has just confirmed they are
// active and paying. Locking them out because we cannot name their product
// would break live customers, so they get resolveTier's *unconfigured
// default* — the same tier this site granted everyone before tiers existed
// (WHOP_DEFAULT_TIER, else 'complete'). Passing an env with no allowlists
// forces that branch deliberately: the allowlists classify Whop products, and
// a Sheet-only member has no product id to classify, so 'not_allowlisted'
// would be the wrong answer, not a safer one.
function unconfiguredDefaultTier(env) {
  return resolveTier({ WHOP_DEFAULT_TIER: env && env.WHOP_DEFAULT_TIER }, {}).tier;
}

// ---------------------------------------------------------------------------
// RETIRING THE SHEET — what is actually left
// ---------------------------------------------------------------------------
//
// The Sheet is now a fallback that D1 overrides and never the reverse: a
// revoked or expired D1 row is refused above without the bridge being asked,
// and a code the webhook minted works before any human touches the Sheet.
// What still has to happen before MEMBERS_STATUS_URL / MEMBERS_BRIDGE_URL and
// the branch below can be deleted:
//
//   1. Backfill. Every member who exists only as a Sheet row needs a
//      whop_codes row (member_ref, status, tier, expires_at). We hold only
//      hashes of codes we minted, so codes issued by hand before the webhook
//      existed CANNOT be reconstructed from D1 — the owner must either
//      re-issue those members a code through Whop or export the Sheet and
//      import sha256(code) rows. This is the one step nobody can automate
//      from inside this repo.
//   2. Verify the backfill: for a sampled set of Sheet-active members,
//      sign-in must succeed with MEMBERS_STATUS_URL unset.
//   3. Flip STRICT_D1_ENTITLEMENTS=true. Until then a cookie minted from the
//      Sheet is allowed to survive when D1 has no row for it (see
//      _lib/session.js sessionEntitlementCheck) — that is the last remaining
//      way a Sheet-era member outlives a D1 decision, and it closes the day
//      step 1 is done.
//   4. Only then delete the bridge branch here, in check-member-status.js,
//      and the Apps Script endpoint.
//
// Until step 1 is done this bridge is load-bearing. Do not delete it early.

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
export { GENERIC_BAD_CODE, MEMBERSHIP_ENDED };
