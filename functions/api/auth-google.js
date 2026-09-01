// Cloudflare Pages Function: POST /api/auth-google
//
// "Sign in with Google" as a convenience layer on TOP OF the existing
// Whop-driven membership system. It does not replace access codes — it
// matches the signed-in Google account's email against a purchase the
// whop-webhook already recorded (see migration 0004: whop_codes.email_hash),
// and issues the same kind of session cookie verify-premium.js does.
//
// The Google ID token is verified against Google's own tokeninfo endpoint
// (no client secret needed — Google signs the token, tokeninfo checks the
// signature + expiry for us) and its `aud` claim is pinned to our own
// GOOGLE_CLIENT_ID so a token minted for a different site can't be replayed
// here.
//
// Env vars:
//   GOOGLE_CLIENT_ID          required — OAuth Web Client ID from Google
//                             Cloud Console (public value, not a secret)
//   SESSION_SIGNING_SECRET    required, shared with verify-premium.js
//   RESEARCH_DB               required — holds whop_codes
//
// D1 is the sole authority on this path — there is no Sheet fallback here at
// all. The row's status and expires_at are evaluated by the same shared rule
// (_lib/session.js entitlementRowState) that the mid-session revocation check
// uses, so "may sign in" and "may stay signed in" can never drift apart. The
// session carries `sv` (the row's session epoch) so a later cancellation
// kills the cookie without waiting it out.

import {
  resolveSigningSecret, signSession, sessionDays,
  entitlementRowState, memberRefFromCodeHash, SESSION_SOURCE,
} from './_lib/session.js';
import { json, jsonWithSession, checkRateLimit } from './_lib/http.js';
import { SESSION_VERSION, isTier, resolveTier } from './_lib/entitlements.js';

const EXPIRED = 'That membership has expired. Renew on Whop, or contact support in Discord if you think this is wrong.';

const NO_MATCH = 'That Google account isn\u2019t linked to an active membership yet. Sign in with your access code once to link it, or contact support in Discord.';

export async function onRequestPost(context) {
  try { return await handle(context); }
  catch { return json({ ok: false, error: 'Sign-in is temporarily unavailable.' }, 502); }
}

async function handle(context) {
  const { request, env } = context;

  const limit = await checkRateLimit(env, request, 'auth-google', 10);
  if (!limit.allowed) {
    return json({ ok: false, error: 'Too many attempts. Wait a minute and try again.' }, 429);
  }

  if (!env.GOOGLE_CLIENT_ID) {
    return json({ ok: false, error: 'Google Sign-In is not configured on this deployment.' }, 503);
  }
  const secret = resolveSigningSecret(env);
  if (!secret) {
    return json({ ok: false, error: 'Sign-in is not configured. Contact the admin.' }, 503);
  }
  if (!env.RESEARCH_DB) {
    return json({ ok: false, error: 'Sign-in is not configured. Contact the admin.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const credential = String(body.credential || '').trim();
  if (!credential || credential.length > 4096) {
    return json({ ok: false, error: 'Missing Google credential.' }, 400);
  }

  const claims = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  // tokeninfo returns claims as STRINGS ('email_verified': 'true'/'false'),
  // so a strict === false check never fired and unverified accounts passed.
  // Require an affirmative 'true' rather than the absence of false.
  if (!claims || !claims.email || String(claims.email_verified) !== 'true') {
    return json({ ok: false, error: 'Could not verify that Google account.' }, 401);
  }

  const email = String(claims.email).trim().toLowerCase();
  const emailHash = await sha256Hex(email);

  // `status != 'revoked'` is not the same as "entitled": a 'pending' row (a
  // code that was minted but never delivered) is not a membership either, and
  // ordering by created_at could hand back a newer dead row while an older
  // live one exists. Select the candidates and let the shared entitlement
  // rule — the same one the mid-session revocation check applies — decide.
  const rows = await env.RESEARCH_DB.prepare(
    `SELECT code_hash, discord, plan_name, expires_at, whop_product, tier, status, session_epoch
     FROM whop_codes
     WHERE email_hash = ?1
     ORDER BY created_at DESC LIMIT 10`
  ).bind(emailHash).all().catch(() => null);

  const candidates = rows && Array.isArray(rows.results) ? rows.results : [];
  if (candidates.length === 0) {
    return json({ ok: false, error: NO_MATCH }, 404);
  }

  const now = Date.now();
  const evaluated = candidates.map((r) => ({ row: r, state: entitlementRowState(r, now) }));
  const winner = evaluated.find((e) => e.state.live);

  if (!winner) {
    // Every record on file for this account is dead. An expired or revoked
    // membership must be REFUSED here — the old code fell through to a fresh
    // default-length session, i.e. handed a lapsed member strictly more
    // access than their own plan said they had.
    const anyExpired = evaluated.some((e) => e.state.reason === 'expired');
    return json({ ok: false, error: anyExpired ? EXPIRED : NO_MATCH }, anyExpired ? 403 : 404);
  }

  const { row, state } = winner;
  const days = sessionDays(env);
  // A yearly Whop plan must not mint a year-long irrevocable token: honor
  // the plan expiry but never exceed the session-length cap.
  const capped = now + days * 24 * 60 * 60 * 1000;
  const expiresAt = state.expiresAt === null ? capped : Math.min(state.expiresAt, capped);

  const token = await signSession(
    {
      v: SESSION_VERSION,
      mr: memberRefFromCodeHash(row.code_hash),
      dn: row.discord || '',
      t: tierForRow(env, row),
      sv: state.epoch,
      src: SESSION_SOURCE.D1,
      exp: expiresAt,
    },
    secret
  );

  return jsonWithSession(
    {
      ok: true,
      expiresAt: new Date(expiresAt).toISOString(),
      discord: row.discord || null,
      plan: row.plan_name || null,
    },
    token,
    Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
  );
}

// The tier this purchase actually bought. Preference order:
//   1. whop_codes.tier — what the webhook resolved at purchase time
//      (migration 0005); authoritative and already validated.
//   2. Re-resolve from the stored product/plan against the env allowlists,
//      for rows written before 0005 shipped.
//   3. resolveTier's unconfigured default. Rows this old predate any product
//      classification, and this account has just proven it matches a real,
//      non-revoked, unexpired purchase — locking those members out to make
//      the model tidy would break live customers.
function tierForRow(env, row) {
  if (isTier(row.tier)) return row.tier;
  const resolved = resolveTier(env, { product: row.whop_product || '', plan: row.plan_name || '' });
  if (isTier(resolved.tier)) return resolved.tier;
  return resolveTier({ WHOP_DEFAULT_TIER: env && env.WHOP_DEFAULT_TIER }, {}).tier;
}

async function verifyGoogleIdToken(idToken, expectedAudience) {
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') return null;
  if (String(data.aud || '') !== String(expectedAudience)) return null;
  const iss = String(data.iss || '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return null;
  if (!Number.isFinite(Number(data.exp)) || Number(data.exp) * 1000 <= Date.now()) return null;
  return data;
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
