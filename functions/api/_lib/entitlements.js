// Entitlement model — what a paying member is actually allowed to see.
//
// Before this module the site sold two products ($100 Futures Only, $129
// Complete) but authorization knew about neither: the signed session carried
// { v, mr, dn, exp } with no tier claim, and functions/_middleware.js gated
// every course on `!!getSession(...)` — any valid session. A Futures buyer
// therefore received the whole Complete library, which both misrepresents the
// two products and makes the Core -> Complete upgrade impossible to sell.
//
// Design rules this module exists to enforce:
//
//   1. Tier is a SIGNED claim. It is minted where entitlement is established
//      (Whop webhook / code sign-in / Google sign-in) and read from the token,
//      never inferred client-side or from an unsigned header.
//   2. An unrecognized Whop product NEVER grants access. A cheaper product or
//      a separately sold indicator must not become a full-course credential
//      just because its event reached our endpoint.
//   3. Resource -> required tier is declared in one table, server-side, so a
//      new gated page cannot silently default to "any session will do".
//
// Configuration (Cloudflare env vars):
//   WHOP_PRODUCTS_FUTURES   comma-separated Whop product/plan ids -> futures_core
//   WHOP_PRODUCTS_COMPLETE  comma-separated Whop product/plan ids -> complete
//   WHOP_DEFAULT_TIER       tier used only while neither list is configured
//                           (default 'complete' — preserves today's behaviour
//                           so deploying this does not lock out live members)
//   STRICT_LEGACY_SESSIONS  'true' rejects pre-tier (v1) tokens instead of
//                           grandfathering them until they expire

export const TIERS = Object.freeze({
  FREE: 'free',
  FUTURES_CORE: 'futures_core',
  COMPLETE: 'complete',
});

/** Ordered so a higher tier satisfies every requirement a lower one does. */
const RANK = Object.freeze({ free: 0, futures_core: 1, complete: 2 });

/** Session payload version that carries a `t` (tier) claim. */
export const SESSION_VERSION = 2;

export function isTier(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value);
}

export function tierRank(tier) {
  return isTier(tier) ? RANK[tier] : -1;
}

/** Does a member holding `held` satisfy a requirement of `required`? */
export function tierAllows(held, required) {
  if (!isTier(required)) return false;      // unknown requirement: fail closed
  if (!isTier(held)) return false;
  return RANK[held] >= RANK[required];
}

/**
 * Which tier a given course page / paid API requires.
 *
 * Futures Core buys the futures track plus the risk-and-psychology material
 * the futures track depends on. Stocks and Options are Complete-only, and so
 * are the premium research tools.
 */
export const RESOURCE_TIERS = Object.freeze({
  '/futures-dissection': TIERS.FUTURES_CORE,
  '/futures-dissection.html': TIERS.FUTURES_CORE,
  '/psychology-enhancer': TIERS.FUTURES_CORE,
  '/psychology-enhancer.html': TIERS.FUTURES_CORE,
  '/stock-breakdown': TIERS.COMPLETE,
  '/stock-breakdown.html': TIERS.COMPLETE,
  '/options-lab': TIERS.COMPLETE,
  '/options-lab.html': TIERS.COMPLETE,
  '/api/research-engine': TIERS.COMPLETE,
  '/api/premium-stock-research': TIERS.COMPLETE,
  '/api/premium-market-analyst': TIERS.COMPLETE,
});

/** Required tier for a path, or null when the path is not gated at all. */
export function requiredTierFor(pathname) {
  return Object.prototype.hasOwnProperty.call(RESOURCE_TIERS, pathname)
    ? RESOURCE_TIERS[pathname]
    : null;
}

/** Parse a comma/whitespace-separated env allowlist into a lowercase Set. */
export function parseIdList(raw) {
  if (typeof raw !== 'string') return new Set();
  return new Set(
    raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Map a Whop product/plan identifier onto one of our tiers.
 *
 * Returns { tier, reason }. `tier` is null when the caller must NOT grant.
 * Reasons are distinct so callers can log why, and so tests can tell an
 * unconfigured deployment apart from a rejected product.
 */
export function resolveTier(env, { product = '', plan = '' } = {}) {
  const futures = parseIdList(env && env.WHOP_PRODUCTS_FUTURES);
  const complete = parseIdList(env && env.WHOP_PRODUCTS_COMPLETE);
  const ids = [product, plan]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);

  if (futures.size === 0 && complete.size === 0) {
    // Not configured yet. Fail *open to the previous behaviour* rather than
    // locking out paying members the moment this ships — but say so, loudly,
    // so the owner knows strict mode is not on until the lists are set.
    const fallback = isTier(env && env.WHOP_DEFAULT_TIER)
      ? env.WHOP_DEFAULT_TIER
      : TIERS.COMPLETE;
    return { tier: fallback, reason: 'unconfigured_default' };
  }

  // Complete wins ties: a member listed in both lists is not downgraded.
  if (ids.some((id) => complete.has(id))) return { tier: TIERS.COMPLETE, reason: 'allowlist' };
  if (ids.some((id) => futures.has(id))) return { tier: TIERS.FUTURES_CORE, reason: 'allowlist' };
  return { tier: null, reason: ids.length ? 'not_allowlisted' : 'no_product_id' };
}

/**
 * The tier a verified session actually carries.
 *
 * Tokens minted before this change have no `t`. They are grandfathered to
 * Complete until they expire on their own (7 days by default, 30 max), which
 * keeps current members signed in without minting any new untiered token —
 * the window closes by itself. Set STRICT_LEGACY_SESSIONS=true to cut it
 * short and force everyone to re-authenticate once.
 */
export function sessionTier(session, env) {
  if (!session || typeof session !== 'object') return null;
  if (isTier(session.t)) return session.t;
  const strict = String((env && env.STRICT_LEGACY_SESSIONS) || '').toLowerCase() === 'true';
  if (strict) return null;
  return TIERS.COMPLETE;
}

/** True when this session was minted before tiers existed. */
export function isLegacySession(session) {
  return !!session && typeof session === 'object' && !isTier(session.t);
}

/**
 * One call for "may this session view this path?".
 * Returns { allowed, held, required, legacy }.
 */
export function authorizeResource(session, pathname, env) {
  const required = requiredTierFor(pathname);
  const held = sessionTier(session, env);
  if (required === null) return { allowed: true, held, required: null, legacy: false };
  return {
    allowed: tierAllows(held, required),
    held,
    required,
    legacy: isLegacySession(session),
  };
}
