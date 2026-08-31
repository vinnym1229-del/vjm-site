// Direct coverage for functions/api/_lib/turnstile.js — the last
// functions/api/_lib/*.js file with zero direct test references. It was
// only ever exercised transitively through verify-premium-api.test.mjs's
// mocked global fetch, so verifyTurnstile's own request shape and its
// fail-closed contract (the file's own header comment: "never fail open on
// a check whose entire purpose is blocking automated abuse") had never run
// in isolation. Pins: no-token short-circuit (never calls fetch), a
// non-2xx Cloudflare response failing closed, a thrown/network-error fetch
// failing closed, success requiring the strict boolean `success === true`
// (a truthy non-boolean like the string "true" must still fail), the
// correct siteverify URL/method/content-type/secret+response body, and
// remoteip only being included when an ip is passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnstileConfigured, verifyTurnstile } from '../functions/api/_lib/turnstile.js';

const env = { TURNSTILE_SECRET_KEY: 'test-secret' };

test('turnstileConfigured reflects whether the secret is set', () => {
  assert.equal(turnstileConfigured({}), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SECRET_KEY: '' }), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SECRET_KEY: 'x' }), true);
});

test('verifyTurnstile rejects a missing/non-string token without calling fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Turnstile with no token'); };
  try {
    assert.equal(await verifyTurnstile(env, undefined, '1.2.3.4'), false);
    assert.equal(await verifyTurnstile(env, null, '1.2.3.4'), false);
    assert.equal(await verifyTurnstile(env, '', '1.2.3.4'), false);
    assert.equal(await verifyTurnstile(env, 12345, '1.2.3.4'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyTurnstile fails closed on a non-ok response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    assert.equal(await verifyTurnstile(env, 'tok'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyTurnstile fails closed on a thrown network error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await verifyTurnstile(env, 'tok'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyTurnstile requires success to be strictly boolean true', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: false });
    assert.equal(await verifyTurnstile(env, 'tok'), false);

    globalThis.fetch = async () => Response.json({ success: 'true' });
    assert.equal(await verifyTurnstile(env, 'tok'), false, 'a truthy non-boolean must still fail closed');

    globalThis.fetch = async () => Response.json({});
    assert.equal(await verifyTurnstile(env, 'tok'), false);

    globalThis.fetch = async () => Response.json({ success: true });
    assert.equal(await verifyTurnstile(env, 'tok'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyTurnstile posts the documented request shape and only forwards remoteip when given', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ success: true });
  };
  try {
    await verifyTurnstile(env, 'tok-abc', '9.9.9.9');
    await verifyTurnstile(env, 'tok-xyz');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  }

  const withIp = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(withIp.get('secret'), 'test-secret');
  assert.equal(withIp.get('response'), 'tok-abc');
  assert.equal(withIp.get('remoteip'), '9.9.9.9');

  const withoutIp = new URLSearchParams(calls[1].init.body.toString());
  assert.equal(withoutIp.get('response'), 'tok-xyz');
  assert.equal(withoutIp.has('remoteip'), false, 'remoteip must be omitted, not sent empty, when no ip is passed');
});

console.log('VJM turnstile lib tests passed.');
