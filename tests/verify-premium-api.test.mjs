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
} finally {
  globalThis.fetch = originalFetch;
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
