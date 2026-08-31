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

// Returns the payload for a correctly-signed, unexpired cookie — WITHOUT
// asking D1 whether that member is still entitled. Use this only where the
// answer is "who was this cookie issued to?" rather than "may this request
// proceed?" (logout, diagnostics). Everything that gates paid content must
// use getSession().
export async function verifySessionCookie(request, env) {
  const secret = resolveSigningSecret(env);
  if (!secret) return null;
  const token = readSessionCookie(request);
  if (!token) return null;
  return verifySessionToken(token, secret);
}

// ---------------------------------------------------------------------------
// Entitlement state — D1 is the authority
// ---------------------------------------------------------------------------

/** Where the entitlement a session was minted from actually lives. */
export const SESSION_SOURCE = Object.freeze({ D1: 'd1', SHEET: 'sheet' });

/**
 * whop_codes.status values that mean "this member may be let in".
 *
 * 'active'    — written by the webhook once the purchase is provisioned.
 * 'renewed'   — the member bridge's vocabulary, accepted for parity.
 * 'delivered' — what the webhook wrote before migration 0006 renamed it.
 *
 * Anything else — 'pending' (code minted but never delivered), 'revoked', an
 * empty string, or a value nobody has seen before — is NOT live. The set is
 * an allowlist on purpose: a status this code does not recognize must fail
 * closed, because the alternative is a typo silently granting access.
 */
export const LIVE_ENTITLEMENT_STATUSES = Object.freeze(['active', 'renewed', 'delivered']);

/**
 * Decide whether one whop_codes row entitles its holder, right now.
 * Returns { live, reason, expiresAt, epoch }.
 *
 * This is the ONE place expiry is evaluated, so every path that mints or
 * accepts a session agrees on what "expired" means. `expires_at <= now` is a
 * refusal, never a reason to fall through to a fresh default-length session.
 */
export function entitlementRowState(row, nowMs = Date.now()) {
  if (!row || typeof row !== 'object') return { live: false, reason: 'no_row', expiresAt: null, epoch: 1 };
  const epoch = Number.isFinite(Number(row.session_epoch)) ? Number(row.session_epoch) : 1;
  const status = String(row.status == null ? '' : row.status).trim().toLowerCase();
  const rawExpiry = row.expires_at ? Date.parse(row.expires_at) : NaN;
  const expiresAt = Number.isFinite(rawExpiry) ? rawExpiry : null;
  if (status === 'revoked') return { live: false, reason: 'revoked', expiresAt, epoch };
  if (!LIVE_ENTITLEMENT_STATUSES.includes(status)) {
    return { live: false, reason: 'status_' + (status || 'missing'), expiresAt, epoch };
  }
  if (expiresAt !== null && expiresAt <= nowMs) return { live: false, reason: 'expired', expiresAt, epoch };
  return { live: true, reason: 'live', expiresAt, epoch };
}

const ENTITLEMENT_COLUMNS =
  'code_hash, status, expires_at, session_epoch, tier, discord, whop_product, plan_name';

/** Fetch the entitlement row for a member ref (the session's `mr` claim). */
export async function loadEntitlementByRef(env, memberRef) {
  const db = env && env.RESEARCH_DB;
  if (!db) return { ok: false, row: null, reason: 'no_db' };
  const ref = String(memberRef || '');
  if (!/^[0-9a-f]{8,64}$/.test(ref)) return { ok: false, row: null, reason: 'unusable_ref' };
  try {
    const row = await db
      .prepare(`SELECT ${ENTITLEMENT_COLUMNS} FROM whop_codes WHERE member_ref = ?1 LIMIT 1`)
      .bind(ref).first();
    return { ok: true, row: row || null, reason: row ? 'found' : 'no_row' };
  } catch {
    return { ok: false, row: null, reason: 'db_error' };
  }
}

/** Fetch the entitlement row for a full code hash (the access-code path). */
export async function loadEntitlementByCodeHash(env, codeHash) {
  const db = env && env.RESEARCH_DB;
  if (!db) return { ok: false, row: null, reason: 'no_db' };
  const hash = String(codeHash || '');
  if (!/^[0-9a-f]{16,128}$/.test(hash)) return { ok: false, row: null, reason: 'unusable_hash' };
  try {
    const row = await db
      .prepare(`SELECT ${ENTITLEMENT_COLUMNS} FROM whop_codes WHERE code_hash = ?1 LIMIT 1`)
      .bind(hash).first();
    return { ok: true, row: row || null, reason: row ? 'found' : 'no_row' };
  } catch {
    return { ok: false, row: null, reason: 'db_error' };
  }
}

/** The member ref both sign-in paths sign into `mr` (migration 0006). */
export function memberRefFromCodeHash(codeHash) {
  return String(codeHash || '').slice(0, 16);
}

/**
 * Does the D1 record behind an already-signed cookie still permit this
 * request? Returns { ok, reason }.
 *
 * This is the fix for the core leak: the cookie is a stateless bearer token
 * good for up to 30 days, so before this check a cancellation reached a
 * signed-in member only when their cookie happened to expire. Now every
 * gated request re-reads the member's row.
 *
 * Failure modes, chosen deliberately:
 *
 *  - Row says revoked / expired / an unrecognized status  -> DENY. This is
 *    the whole point; a revoked D1 row beats anything the Sheet says.
 *  - Row's session_epoch is newer than the cookie's `sv`  -> DENY. Bumping
 *    the epoch is how the webhook kills outstanding cookies on cancellation.
 *  - No row at all, for a session minted FROM D1 (`src:'d1'`) -> DENY. The
 *    row existed when the session was signed; its disappearance is exactly
 *    the unexpected state we must fail closed on.
 *  - No row at all, for a session minted from the Sheet bridge
 *    (`src:'sheet'`, or a pre-0006 cookie with no `src`) -> ALLOW. Legacy
 *    members' codes predate whop_codes entirely; denying them would sign out
 *    every existing paying customer the moment this ships. Set
 *    STRICT_D1_ENTITLEMENTS=true once the Sheet is retired to make this deny
 *    too, at which point the bridge can be deleted.
 *  - No RESEARCH_DB bound, or D1 itself errored -> ALLOW (soft-fail), unless
 *    STRICT_D1_ENTITLEMENTS=true. A D1 outage would otherwise sign out every
 *    paying member on the site at once. The exposure is bounded by the
 *    cookie's own lifetime, and the owner can trade availability for
 *    strictness with one env var. See the report note on this decision.
 */
export async function sessionEntitlementCheck(session, env) {
  const strict = String((env && env.STRICT_D1_ENTITLEMENTS) || '').toLowerCase() === 'true';
  if (!session || typeof session !== 'object') return { ok: false, reason: 'no_session' };

  const lookup = await loadEntitlementByRef(env, session.mr);
  if (!lookup.ok) return { ok: !strict, reason: lookup.reason };

  if (!lookup.row) {
    if (session.src === SESSION_SOURCE.D1) return { ok: false, reason: 'row_missing' };
    return { ok: !strict, reason: 'sheet_bridge_member' };
  }

  const state = entitlementRowState(lookup.row);
  if (!state.live) return { ok: false, reason: state.reason };

  const minted = Number(session.sv);
  if (Number.isFinite(minted) && state.epoch > minted) return { ok: false, reason: 'stale_epoch' };
  return { ok: true, reason: 'live' };
}

/**
 * Returns the verified session payload for this request, or null.
 *
 * WHY THE D1 READ LIVES HERE, and what it does NOT cost:
 *
 * Every caller of getSession() is a request that is about to hand over paid
 * material or act on a member's behalf — functions/_middleware.js (only
 * after it has matched one of the four gated course pages; it returns
 * early for every other path, so static assets, images and public pages
 * never reach this function), /api/research-engine, /api/assistant,
 * /api/verify-premium's state probe, /api/logout-premium. That is a handful
 * of D1 reads per member session, not one per asset. Putting the check any
 * lower (e.g. in verifySessionToken) would drag it into pure token tests;
 * putting it any higher would mean every gate re-implementing it, which is
 * how the three-way split of truth happened in the first place.
 *
 * There is deliberately NO caching layer here: a cache TTL is exactly the
 * revocation delay we just removed. If the read ever shows up in the D1
 * budget, cap it with a per-isolate cache measured in seconds and say so —
 * do not raise it to minutes.
 */
export async function getSession(request, env) {
  const session = await verifySessionCookie(request, env);
  if (!session) return null;
  const check = await sessionEntitlementCheck(session, env);
  return check.ok ? session : null;
}
