// Security tests: session signing, secret resolution, cookie hardening,
// and the premium verification contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  timingSafeEqual, resolveSigningSecret, signSession, verifySessionToken,
  buildSessionCookie, buildClearCookie, readSessionCookie, getSession,
} from '../functions/api/_lib/session.js';

const SECRET = 'x'.repeat(48);
const env = { SESSION_SIGNING_SECRET: SECRET };

test('session roundtrip signs and verifies', async () => {
  const exp = Date.now() + 60_000;
  const token = await signSession({ v: 1, mr: 'abcd1234', dn: 'trader', exp }, SECRET);
  const payload = await verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload.mr, 'abcd1234');
  assert.equal(payload.dn, 'trader');
});

test('tampered payload is rejected', async () => {
  const exp = Date.now() + 60_000;
  const token = await signSession({ v: 1, mr: 'abcd1234', dn: '', exp }, SECRET);
  const [body] = token.split('.');
  const forged = body + '.' + 'A'.repeat(43);
  assert.equal(await verifySessionToken(forged, SECRET), null);
  // signature from a different secret must not validate either
  const otherToken = await signSession({ v: 1, mr: 'abcd1234', dn: '', exp }, 'y'.repeat(48));
  assert.equal(await verifySessionToken(otherToken, SECRET), null);
});

test('expired sessions are rejected', async () => {
  const token = await signSession({ v: 1, mr: 'k', dn: '', exp: Date.now() - 1000 }, SECRET);
  assert.equal(await verifySessionToken(token, SECRET), null);
});

test('garbage tokens are rejected without throwing', async () => {
  assert.equal(await verifySessionToken('', SECRET), null);
  assert.equal(await verifySessionToken('abc', SECRET), null);
  assert.equal(await verifySessionToken('a.b.c', SECRET), null);
  assert.equal(await verifySessionToken(null, SECRET), null);
});

test('timingSafeEqual accepts equal / rejects unequal incl. length mismatch', () => {
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('signing secret resolution fails closed', () => {
  assert.equal(resolveSigningSecret({}), null);
  assert.equal(resolveSigningSecret({ SESSION_SIGNING_SECRET: 'short' }), null);
  assert.equal(resolveSigningSecret({ PREMIUM_ACCESS_CODES: 'CODE1,CODE2' }), null); // codes are never key material
  assert.ok(resolveSigningSecret({ SESSION_SIGNING_SECRET: SECRET }));
  // legacy migration hatch must be explicit
  assert.ok(resolveSigningSecret({
    LEGACY_ALLOW_CODES_AS_KEY: 'true',
    PREMIUM_ACCESS_CODES: 'CODE1,CODE2',
  }).startsWith('legacy:'));
  assert.equal(resolveSigningSecret({
    LEGACY_ALLOW_CODES_AS_KEY: 'false',
    PREMIUM_ACCESS_CODES: 'CODE1,CODE2',
  }), null);
});

test('session cookies are HttpOnly+Secure+SameSite=Lax with Max-Age', () => {
  const c = buildSessionCookie('tok.value', 86400);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=86400', 'Path=/']) {
    assert.ok(c.includes(flag), `cookie missing ${flag}: ${c}`);
  }
  const cleared = buildClearCookie();
  assert.ok(cleared.includes('Max-Age=0'));
});

test('cookie reader extracts session value only', () => {
  const req = { headers: { get: (h) => h === 'Cookie' ? 'other=1; __Host-vjm_session=tok.value; x=y' : null } };
  assert.equal(readSessionCookie(req), 'tok.value');
  const none = { headers: { get: () => null } };
  assert.equal(readSessionCookie(none), null);
});

test('getSession verifies request end-to-end', async () => {
  const exp = Date.now() + 60_000;
  const token = await signSession({ v: 1, mr: 'ff', dn: '', exp }, SECRET);
  const req = { headers: { get: (h) => h === 'Cookie' ? `__Host-vjm_session=${token}` : null } };
  const payload = await getSession(req, env);
  assert.ok(payload && payload.mr === 'ff');
  assert.equal(await getSession(req, {}), null);
});
