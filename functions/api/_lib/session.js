// Shared session utilities for VJM Pages Functions.
//
// Security model:
// - Sessions are HMAC-SHA256 signed opaque tokens carried ONLY in an
//   HttpOnly; Secure; SameSite=Lax cookie. Tokens never appear in HTML,
//   JS-readable storage, URLs, or response bodies.
// - Signing uses SESSION_SIGNING_SECRET exclusively. PREMIUM_ACCESS_CODES
//   (a collection of member codes) is NEVER acceptable key material and is
//   only honored as a read-only migration path when explicitly enabled.
// - All comparisons are constant-time. Missing secret = fail closed.

// __Host- gives browser-enforced guarantees: Secure, Path=/, no Domain —
// a subdomain (or attacker-controlled sibling) cannot plant or override it.
// Renaming invalidates sessions issued under the old name; members sign in
// again once.
const SESSION_COOKIE = '__Host-vjm_session';
const DEFAULT_SESSION_DAYS = 7;
const MAX_SESSION_DAYS = 30;

function encoder() {
  return new TextEncoder();
}

export function timingSafeEqual(a, b) {
  const ab = encoder().encode(String(a));
  const bb = encoder().encode(String(b));
  if (ab.length !== bb.length) {
    // Still burn comparable time to avoid length-oracle timing.
    let sink = 0;
    for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
      sink |= (ab[i % (ab.length || 1)] || 0) ^ (bb[i % (bb.length || 1)] || 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder().encode(message));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

export function base64UrlEncodeBytes(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecodeToBytes(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Signing secrets
// ---------------------------------------------------------------------------

// Returns the dedicated signing secret, or null when not configured.
// LEGACY_ALLOW_CODES_AS_KEY=true temporarily permits the old (unsafe)
// PREMIUM_ACCESS_CODES-as-key behavior during owner migration only.
export function resolveSigningSecret(env) {
  if (env.SESSION_SIGNING_SECRET && String(env.SESSION_SIGNING_SECRET).length >= 32) {
    return String(env.SESSION_SIGNING_SECRET);
  }
  if (String(env.LEGACY_ALLOW_CODES_AS_KEY || '') === 'true' && env.PREMIUM_ACCESS_CODES) {
    return 'legacy:' + String(env.PREMIUM_ACCESS_CODES);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token sign / verify  (payload is a plain JSON object)
// ---------------------------------------------------------------------------

export async function signSession(payload, secret) {
  const body = base64UrlEncodeBytes(encoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, secret);
  return body + '.' + sig;
}

export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = await hmac(parts[0], secret);
  if (!timingSafeEqual(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(parts[0])));
    if (!payload || typeof payload !== 'object') return null;
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function sessionDays(env) {
  const n = Number(env.SESSION_DAYS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_DAYS;
  return Math.min(Math.ceil(n), MAX_SESSION_DAYS);
}

export function buildSessionCookie(token, maxAgeSeconds) {
  // __Host- prefix requires Secure, Path=/, no Domain — strongest form.
  // Cloudflare Pages serves HTTPS on all routes so __Host- is valid.
  const name = SESSION_COOKIE;
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
  ];
  return parts.join('; ');
}

export function buildClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(request) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const piece of header.split(';')) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    const name = piece.slice(0, idx).trim();
    if (name === SESSION_COOKIE) return piece.slice(idx + 1).trim();
  }
  return null;
}

// Returns the verified session payload for this request, or null.
export async function getSession(request, env) {
  const secret = resolveSigningSecret(env);
  if (!secret) return null;
  const token = readSessionCookie(request);
  if (!token) return null;
  return verifySessionToken(token, secret);
}
