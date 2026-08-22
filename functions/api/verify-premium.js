// Cloudflare Pages Function backing premium access across the whole site.
//
// POST /api/verify-premium   { "code": "JOHN-2298" }
//   -> checks the code against the live sheet bridge (same MEMBERS_STATUS_URL
//      used by check-member-status.js). If the code exists and its member's
//      status is Active/Renewed, issues a signed session token.
//
// GET  /api/verify-premium with Authorization: Bearer <token>
//   -> validates a previously-issued token without placing it in a URL.
//      The legacy ?token= form remains accepted for compatibility.
//
// Env vars used:
//   MEMBERS_STATUS_URL   - the Apps Script bridge URL (already configured)
//   SESSION_DAYS         - how many days a session stays valid (default 7)
//   PREMIUM_ACCESS_CODES - reused as the HMAC signing secret for tokens

export async function onRequestPost(context) {
  try { return await handlePost(context); }
  catch (err) { return jsonResponse({ ok: false, error: 'Unexpected error: ' + describeError(err) }, 500); }
}

export async function onRequestGet(context) {
  try { return await handleGet(context); }
  catch (err) { return jsonResponse({ ok: false, error: 'Unexpected error: ' + describeError(err) }, 500); }
}

async function handlePost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const code = String(body.code || '').trim().toUpperCase();
  if (!code) {
    return jsonResponse({ ok: false, error: 'Enter your premium access code.' }, 400);
  }

  const bridge = await fetchBridge(env);
  if (!bridge.ok) return jsonResponse({ ok: false, error: bridge.error }, 502);

  const codes = bridge.data.codes || {};
  const match = codes[code];
  if (!match) {
    return jsonResponse({ ok: false, error: 'Incorrect code. DM St1101 on Discord for access.' }, 401);
  }

  const normalized = String(match.status || '').toLowerCase();
  const active = normalized === 'active' || normalized === 'renewed';
  if (!active) {
    return jsonResponse({ ok: false, error: 'This code is on file but not currently active. DM St1101 on Discord.' }, 403);
  }

  const sessionDays = Number(env.SESSION_DAYS) > 0 ? Number(env.SESSION_DAYS) : 7;
  const expiresAt = Date.now() + sessionDays * 24 * 60 * 60 * 1000;
  const token = await signToken({ code, discord: match.discord, exp: expiresAt }, signingSecret(env));

  return jsonResponse({ ok: true, token, expiresAt: new Date(expiresAt).toISOString(), discord: match.discord });
}

async function handleGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : (url.searchParams.get('token') || '');
  if (!token) return jsonResponse({ ok: false, error: 'Missing token' }, 400);

  const payload = await verifyToken(token, signingSecret(env));
  if (!payload) return jsonResponse({ ok: false, active: false, error: 'Invalid or tampered session token' }, 401);
  if (payload.exp < Date.now()) return jsonResponse({ ok: false, active: false, error: 'Session expired' }, 401);

  return jsonResponse({ ok: true, active: true, discord: payload.discord });
}

async function fetchBridge(env) {
  const sourceUrl = env.MEMBERS_STATUS_URL;
  if (!sourceUrl) return { ok: false, error: 'MEMBERS_STATUS_URL is not configured' };

  let res, rawText, data;
  try {
    res = await fetch(sourceUrl, { cf: { cacheTtl: 15, cacheEverything: true } });
    rawText = await res.text();
  } catch (err) {
    return { ok: false, error: 'Could not reach the member status sheet' };
  }
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, error: 'Sheet bridge did not return JSON (got: ' + rawText.slice(0, 200) + ')' };
  }
  if (!data || data.ok !== true) {
    return { ok: false, error: (data && data.error) || 'Sheet bridge returned an error' };
  }
  return { ok: true, data };
}

function signingSecret(env) {
  if (!env.PREMIUM_ACCESS_CODES) throw new Error('PREMIUM_ACCESS_CODES is not configured');
  return env.PREMIUM_ACCESS_CODES;
}

async function signToken(payload, secret) {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sigB64 = await hmac(payloadB64, secret);
  return payloadB64 + '.' + sigB64;
}

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expectedSig = await hmac(payloadB64, secret);
  if (!timingSafeEqual(sigB64, expectedSig)) return null;
  try {
    return JSON.parse(base64UrlDecode(payloadB64));
  } catch (err) {
    return null;
  }
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function describeError(err) {
  return err && err.message ? err.message : String(err);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
