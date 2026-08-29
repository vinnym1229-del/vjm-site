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

import { resolveSigningSecret, signSession, sessionDays } from './_lib/session.js';
import { json, jsonWithSession, checkRateLimit } from './_lib/http.js';

const NO_MATCH = 'That Google account isn’t linked to an active membership yet. Sign in with your access code once to link it, or DM St1101 on Discord.';

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

  const row = await env.RESEARCH_DB.prepare(
    `SELECT code_hash, discord, plan_name, expires_at FROM whop_codes
     WHERE email_hash = ?1 AND status != 'revoked'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(emailHash).first();

  if (!row) {
    return json({ ok: false, error: NO_MATCH }, 404);
  }

  const days = sessionDays(env);
  const fallbackExpiry = Date.now() + days * 24 * 60 * 60 * 1000;
  const storedExpiry = row.expires_at ? Date.parse(row.expires_at) : NaN;
  // A yearly Whop plan must not mint a year-long irrevocable token: honor
  // the plan expiry but never exceed the session-length cap.
  const capped = Date.now() + days * 24 * 60 * 60 * 1000;
  const expiresAt = Number.isFinite(storedExpiry) && storedExpiry > Date.now()
    ? Math.min(storedExpiry, capped) : fallbackExpiry;

  const token = await signSession(
    { v: 1, mr: String(row.code_hash).slice(0, 16), dn: row.discord || '', exp: expiresAt },
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
