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
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM auth-google API tests passed.');
