// Regression coverage for /api/verify-premium (functions/api/verify-premium.js).
//
// This is the code-entry auth endpoint the run cycle's own live-deployment
// probe targets ("POST /api/verify-premium with a bad code and no
// turnstileToken must return the verification-failed message, proves bot
// protection is still enforced") — but that assertion had never been pinned
// as a unit test, only as a manual curl check. It was also the last
// functions/api/*.js file with zero test references. Pins: Turnstile stays
// soft-required until TURNSTILE_SECRET_KEY is set (matches _lib/turnstile.js's
// own comment), becomes mandatory and fails closed once configured (missing
// token, and a verification network failure, both reject rather than
// fail open), the code format gate, the signing-secret fail-closed 503, and
// that a granted session never puts the token in the response body.
import assert from 'node:assert/strict';
import { onRequestPost, onRequestGet, GENERIC_BAD_CODE } from '../functions/api/verify-premium.js';
import { TIERS, SESSION_VERSION } from '../functions/api/_lib/entitlements.js';

// The tier is a SIGNED claim, so the issued cookie is the only place it can
// be read back from — nothing about it is exposed in the JSON body.
function sessionClaims(res) {
  const cookie = res.headers.get('Set-Cookie') || '';
  const token = cookie.split('=').slice(1).join('=').split(';')[0];
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

// D1 fake for the whop_codes tier lookup only. `row` is what the SELECT
// returns; null models a legacy Sheet-only member with no D1 row at all.
function makeDb(row) {
  return { prepare() { return { bind() { return { async first() { return row; }, async run() { return { meta: { changes: 1 } }; } }; } }; } };
}

// The legacy status bridge, plus Turnstile, for the full success path.
function bridgeFetch(code, discord = 'trader1') {
  return async (url) => {
    if (String(url).includes('challenges.cloudflare.com')) return Response.json({ success: true });
    return Response.json({ ok: true, codes: { [code]: { status: 'active', discord } } });
  };
}

function baseEnv() {
  return { SESSION_SIGNING_SECRET: 'x'.repeat(32) };
}

// Each call uses a distinct CF-Connecting-IP so the shared 'verify' rate-limit
// bucket (10/min, no per-request identifier) never trips across this file's
// calls.
let ipCounter = 0;
async function callVerify(env, body) {
  ipCounter += 1;
  const res = await onRequestPost({
    request: new Request('https://example.com/api/verify-premium', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': `10.1.0.${ipCounter}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  });
  const data = await res.json();
  return { status: res.status, data, res };
}

// Missing signing secret fails closed (503) before any code or Turnstile check.
{
  const { status, data } = await callVerify({}, { code: 'ABCD-1234' });
  assert.equal(status, 503);
  assert.equal(data.ok, false);
}

// Malformed request body.
{
  const { status, data } = await callVerify(baseEnv(), 'not-json');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
}

// Bad code format is rejected before any Turnstile check or bridge lookup.
{
  const { status, data } = await callVerify(baseEnv(), { code: 'nope!' });
  assert.equal(status, 401);
  assert.equal(data.error, GENERIC_BAD_CODE);
}

const originalFetch = globalThis.fetch;
try {
  // Turnstile not configured (no TURNSTILE_SECRET_KEY): the check is skipped
  // entirely, even with no turnstileToken — soft-required by design until the
  // owner sets the secret. Falls through to the bridge lookup, which is
  // unconfigured here, so it lands on the generic bad-code message rather
  // than the verification-failed one.
  {
    const { status, data } = await callVerify(baseEnv(), { code: 'ABCD-1234' });
    assert.equal(status, 401);
    assert.equal(data.error, GENERIC_BAD_CODE);
  }

  // Turnstile configured + no turnstileToken in the body: this is the exact
  // scenario the live-deployment probe checks by curl. Must reject with the
  // verification-failed message, never reach the bridge lookup.
  {
    const env = { ...baseEnv(), TURNSTILE_SECRET_KEY: 'secret' };
    globalThis.fetch = async () => { throw new Error('must not call Turnstile with an empty token'); };
    const { status, data } = await callVerify(env, { code: 'ABCD-1234' });
    assert.equal(status, 401);
    assert.equal(data.error, 'Verification failed. Refresh the page and try again.');
  }

  // Turnstile configured, token present, but the verify call itself fails
  // (timeout/network error) — must fail closed, never fail open.
  {
    const env = { ...baseEnv(), TURNSTILE_SECRET_KEY: 'secret' };
    globalThis.fetch = async () => { throw new Error('network down'); };
    const { status, data } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 401);
    assert.equal(data.error, 'Verification failed. Refresh the page and try again.');
  }

  // Turnstile configured, token present, Cloudflare says success:false —
  // rejected same as a network failure.
  {
    const env = { ...baseEnv(), TURNSTILE_SECRET_KEY: 'secret' };
    globalThis.fetch = async () => Response.json({ success: false });
    const { status, data } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 401);
    assert.equal(data.error, 'Verification failed. Refresh the page and try again.');
  }

  // Turnstile passes, but no member bridge is configured on this env, so the
  // code lookup itself has nothing to check against: generic bad-code
  // message, distinct from the verification-failed one, proving the flow
  // moved past the bot check.
  {
    const env = { ...baseEnv(), TURNSTILE_SECRET_KEY: 'secret' };
    globalThis.fetch = async () => Response.json({ success: true });
    const { status, data } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 401);
    assert.equal(data.error, GENERIC_BAD_CODE);
  }

  // Full success path: Turnstile passes, the legacy status bridge has an
  // active code. Must issue a session cookie and never put the token in the
  // JSON body.
  {
    const env = {
      ...baseEnv(),
      TURNSTILE_SECRET_KEY: 'secret',
      MEMBERS_STATUS_URL: 'https://example.com/status.json',
    };
    globalThis.fetch = async (url) => {
      if (String(url).includes('challenges.cloudflare.com')) return Response.json({ success: true });
      return Response.json({ ok: true, codes: { 'ABCD-1234': { status: 'active', discord: 'trader1' } } });
    };
    const { status, data, res } = await callVerify(env, { code: 'abcd-1234', turnstileToken: 'tok' });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.discord, 'trader1');
    const cookie = res.headers.get('Set-Cookie');
    assert.ok(cookie, 'must issue a session cookie');
    assert.ok(cookie.includes('HttpOnly'));
    assert.equal(JSON.stringify(data).includes(cookie.split('=')[1].split(';')[0]), false,
      'the signed session token must never appear in the JSON body');
  }
  // ─────────────────────────────────────────────────────────────────────
  // Entitlement tier on the issued session.
  //
  // Until now every code minted an identical session, so a $100 Futures
  // buyer's cookie was indistinguishable from a $129 Complete buyer's and
  // the middleware had nothing to gate on. The session now carries the tier
  // the whop-webhook persisted on the code's whop_codes row (migration 0005).
  // ─────────────────────────────────────────────────────────────────────
  const BRIDGE_ENV = {
    ...baseEnv(),
    TURNSTILE_SECRET_KEY: 'secret',
    MEMBERS_STATUS_URL: 'https://example.com/status.json',
  };

  // A code whose D1 row says futures_core signs futures_core — not complete.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = { ...BRIDGE_ENV, RESEARCH_DB: makeDb({ tier: TIERS.FUTURES_CORE }) };
    const { status, res } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 200);
    const claims = sessionClaims(res);
    assert.equal(claims.t, TIERS.FUTURES_CORE, 'the code row\u2019s tier must be signed into the session');
    assert.equal(claims.v, SESSION_VERSION, 'a tier-carrying session must declare the tier-aware version');
  }

  // …and a complete row signs complete.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = { ...BRIDGE_ENV, RESEARCH_DB: makeDb({ tier: TIERS.COMPLETE }) };
    const { res } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE);
  }

  // Legacy member: the bridge (the owner's Google Sheet) says they are
  // active, but there is no whop_codes row to name their product — their
  // code predates the webhook entirely. They must keep the access the site
  // granted everyone before tiers existed, not be locked out.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = { ...BRIDGE_ENV, RESEARCH_DB: makeDb(null) };
    const { status, res } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 200);
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE, 'a legacy Sheet-only member must not be locked out');
  }

  // Same when no D1 is bound at all, and the owner can lower that default.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const { res } = await callVerify(BRIDGE_ENV, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE);
  }
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = { ...BRIDGE_ENV, WHOP_DEFAULT_TIER: TIERS.FUTURES_CORE, RESEARCH_DB: makeDb(null) };
    assert.equal(sessionClaims((await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' })).res).t, TIERS.FUTURES_CORE);
  }

  // A junk value in the tier column is not a tier: it must fall back, never
  // be signed through verbatim as a claim the middleware would then read.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = { ...BRIDGE_ENV, RESEARCH_DB: makeDb({ tier: 'superuser' }) };
    const { res } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE, 'an unrecognized stored tier must not become a signed claim');
  }

  // A D1 outage during the tier lookup must not fail a sign-in the member
  // bridge already approved.
  {
    globalThis.fetch = bridgeFetch('ABCD-1234');
    const env = {
      ...BRIDGE_ENV,
      RESEARCH_DB: { prepare() { throw new Error('D1 unavailable'); } },
    };
    const { status, res } = await callVerify(env, { code: 'ABCD-1234', turnstileToken: 'tok' });
    assert.equal(status, 200);
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE);
  }
} finally {
  globalThis.fetch = originalFetch;
}

// A tampered session cookie is not a session: GET must report signed-out
// rather than trusting the payload (which is plain base64, readable and
// editable by anyone) once its HMAC no longer matches.
{
  const forged = Buffer.from(JSON.stringify({
    v: SESSION_VERSION, mr: 'ff', dn: '', t: TIERS.COMPLETE, exp: Date.now() + 60000,
  })).toString('base64url') + '.notarealsignature';
  const res = await onRequestGet({
    request: new Request('https://example.com/api/verify-premium', {
      headers: { Cookie: `__Host-vjm_session=${forged}` },
    }),
    env: baseEnv(),
  });
  const data = await res.json();
  assert.equal(data.active, false, 'a forged tier claim must not verify as an active session');
}

// GET with no session cookie restores a signed-out state, not an error.
{
  const res = await onRequestGet({
    request: new Request('https://example.com/api/verify-premium'),
    env: baseEnv(),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.active, false);
}

console.log('VJM verify-premium API tests passed.');
