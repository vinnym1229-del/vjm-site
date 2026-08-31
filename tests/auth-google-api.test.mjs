// Regression coverage for /api/auth-google (functions/api/auth-google.js).
//
// This was the last auth-adjacent functions/api/*.js file with zero test
// references. The handler carries a documented fix worth pinning: Google's
// tokeninfo endpoint returns `email_verified` as the STRING 'true'/'false',
// not a boolean, so a naive `=== false` check silently lets unverified
// accounts through. The code now requires an affirmative `=== 'true'`
// string match — this test fails if that ever regresses back to a
// boolean-shaped check. It also pins the session-expiry cap: a yearly Whop
// plan must not mint a year-long token just because the plan itself runs
// that long.
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/auth-google.js';
import { TIERS, SESSION_VERSION } from '../functions/api/_lib/entitlements.js';

// Read back the claims the handler actually signed into the cookie. The
// tier is a SIGNED claim, so the cookie is the only place it can be checked.
function sessionClaims(res) {
  const cookie = res.headers.get('Set-Cookie') || '';
  const token = cookie.split('=').slice(1).join('=').split(';')[0];
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

function makeDb(row) {
  return {
    prepare() {
      return { bind() { return { async first() { return row; } }; } };
    },
  };
}

const CLIENT_ID = 'client-123.apps.googleusercontent.com';

function baseEnv() {
  return {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    SESSION_SIGNING_SECRET: 'x'.repeat(32),
    RESEARCH_DB: makeDb(null),
  };
}

// Each call uses a distinct CF-Connecting-IP so the shared 'auth-google'
// rate-limit bucket (10/min, no per-request identifier) never trips across
// this file's ~10 calls.
let ipCounter = 0;
async function callAuth(env, body) {
  ipCounter += 1;
  const res = await onRequestPost({
    request: new Request('https://example.com/api/auth-google', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': `10.0.0.${ipCounter}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data, res };
}

// Missing config fails closed (503), never falls through to verification.
{
  const { status, data } = await callAuth({ ...baseEnv(), GOOGLE_CLIENT_ID: undefined }, { credential: 'tok' });
  assert.equal(status, 503);
  assert.equal(data.ok, false);
}
{
  const { status } = await callAuth({ ...baseEnv(), SESSION_SIGNING_SECRET: undefined }, { credential: 'tok' });
  assert.equal(status, 503);
}
{
  const { status } = await callAuth({ ...baseEnv(), RESEARCH_DB: undefined }, { credential: 'tok' });
  assert.equal(status, 503);
}

// Malformed request bodies.
{
  const { status } = await callAuth(baseEnv(), 'not-json');
  assert.equal(status, 400);
}
{
  const { status } = await callAuth(baseEnv(), { credential: '' });
  assert.equal(status, 400);
}
{
  const { status } = await callAuth(baseEnv(), { credential: 'a'.repeat(4097) });
  assert.equal(status, 400);
}

const originalFetch = globalThis.fetch;
try {
  // The regression: tokeninfo says 'false' as a string. Must be rejected.
  globalThis.fetch = async () => Response.json({
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email: 'trader@example.com',
    email_verified: 'false',
  });
  const { status, data } = await callAuth(baseEnv(), { credential: 'tok' });
  assert.equal(status, 401);
  assert.equal(data.ok, false);

  // A token minted for a different Google OAuth client must not be replayed
  // here even when it is otherwise well-formed and verified.
  globalThis.fetch = async () => Response.json({
    aud: 'someone-elses-client-id',
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email: 'trader@example.com',
    email_verified: 'true',
  });
  {
    const { status } = await callAuth(baseEnv(), { credential: 'tok' });
    assert.equal(status, 401);
  }

  // Verified Google account with no matching Whop purchase on file.
  globalThis.fetch = async () => Response.json({
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email: 'nomatch@example.com',
    email_verified: 'true',
  });
  {
    const { status, data } = await callAuth({ ...baseEnv(), RESEARCH_DB: makeDb(null) }, { credential: 'tok' });
    assert.equal(status, 404);
    assert.equal(data.ok, false);
  }

  // Verified + matched, but the plan's expires_at is a year out: the issued
  // session must be capped to the (default 7-day) session length, not the
  // plan's own expiry.
  globalThis.fetch = async () => Response.json({
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email: 'paid@example.com',
    email_verified: 'true',
  });
  {
    const farFuture = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString();
    const env = {
      ...baseEnv(),
      RESEARCH_DB: makeDb({ code_hash: 'a'.repeat(40), discord: 'trader1', plan_name: 'Yearly', expires_at: farFuture }),
    };
    const { status, data, res } = await callAuth(env, { credential: 'tok' });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(res.headers.get('Set-Cookie'), 'must issue a session cookie');
    const expiresAt = new Date(data.expiresAt).getTime();
    const cap = Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000; // small slack for test run time
    assert.ok(expiresAt <= cap, `expiresAt (${data.expiresAt}) must be capped near the session length, not the yearly plan's own expiry`);
  }
  // ─────────────────────────────────────────────────────────────────────
  // Expiry and entitlement tier.
  // ─────────────────────────────────────────────────────────────────────
  globalThis.fetch = async () => Response.json({
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
    email: 'paid@example.com',
    email_verified: 'true',
  });

  // The bug the audit found: the stored expiry was only honored while it was
  // still in the FUTURE, and an already-lapsed record fell through to the
  // default 7-day `fallbackExpiry` — so a member whose plan had ended (and
  // whose row was not yet revoked) got a fresh full-length session, i.e.
  // MORE access than their own plan said they had. It must be rejected.
  {
    const expired = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const env = {
      ...baseEnv(),
      RESEARCH_DB: makeDb({ code_hash: 'a'.repeat(40), discord: 'trader1', plan_name: 'Monthly', expires_at: expired, tier: TIERS.COMPLETE }),
    };
    const { status, data, res } = await callAuth(env, { credential: 'tok' });
    assert.equal(status, 403);
    assert.equal(data.ok, false);
    assert.equal(res.headers.get('Set-Cookie'), null, 'an expired membership must leave no session cookie behind');
  }

  // The stored tier is what the session carries: a $100 futures_core record
  // must not mint a session that reaches the $129 Complete library.
  {
    const env = {
      ...baseEnv(),
      RESEARCH_DB: makeDb({ code_hash: 'b'.repeat(40), discord: 'trader2', plan_name: 'Futures Only', expires_at: null, tier: TIERS.FUTURES_CORE }),
    };
    const { status, res } = await callAuth(env, { credential: 'tok' });
    assert.equal(status, 200);
    const claims = sessionClaims(res);
    assert.equal(claims.t, TIERS.FUTURES_CORE, 'the stored tier must be signed into the session');
    assert.equal(claims.v, SESSION_VERSION, 'a tier-carrying session must declare the tier-aware version');
  }

  // A row written before migration 0005 has no tier, so it is re-resolved
  // from the stored Whop product against the allowlists.
  {
    const env = {
      ...baseEnv(),
      WHOP_PRODUCTS_FUTURES: 'prod_futures_100',
      WHOP_PRODUCTS_COMPLETE: 'prod_complete_129',
      RESEARCH_DB: makeDb({ code_hash: 'c'.repeat(40), discord: '', plan_name: null, expires_at: null, whop_product: 'prod_futures_100', tier: null }),
    };
    const { status, res } = await callAuth(env, { credential: 'tok' });
    assert.equal(status, 200);
    assert.equal(sessionClaims(res).t, TIERS.FUTURES_CORE, 'a pre-0005 row must be re-resolved from its product id');
  }

  // A pre-0005 row whose product no longer resolves at all still belongs to
  // a real, non-revoked, unexpired purchase — those members keep the tier
  // the site granted everyone before tiers existed rather than being locked
  // out. (A stored garbage tier is likewise not honored as a tier.)
  {
    const env = {
      ...baseEnv(),
      WHOP_PRODUCTS_COMPLETE: 'prod_complete_129',
      RESEARCH_DB: makeDb({ code_hash: 'd'.repeat(40), discord: '', plan_name: null, expires_at: null, whop_product: 'prod_ancient', tier: 'superuser' }),
    };
    const { status, res } = await callAuth(env, { credential: 'tok' });
    assert.equal(status, 200);
    assert.equal(sessionClaims(res).t, TIERS.COMPLETE, 'a forged/unknown stored tier must not be signed through verbatim');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM auth-google API tests passed.');
