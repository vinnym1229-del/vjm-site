// Security tests: session signing, secret resolution, cookie hardening,
// and the premium verification contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  timingSafeEqual, resolveSigningSecret, signSession, verifySessionToken,
  buildSessionCookie, buildClearCookie, readSessionCookie, getSession, sessionDays,
  verifySessionCookie, entitlementRowState, sessionEntitlementCheck,
  memberRefFromCodeHash, LIVE_ENTITLEMENT_STATUSES,
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

test('sessionDays defaults to 7 and hard-caps at 30 regardless of misconfiguration', () => {
  // auth-google.js's own comment: a yearly Whop plan must not mint a
  // year-long token, so this cap is what actually bounds session lifetime
  // if SESSION_DAYS is ever misconfigured (or left unset) on the owner side.
  assert.equal(sessionDays({}), 7);
  assert.equal(sessionDays({ SESSION_DAYS: '0' }), 7);
  assert.equal(sessionDays({ SESSION_DAYS: '-5' }), 7);
  assert.equal(sessionDays({ SESSION_DAYS: 'not-a-number' }), 7);
  assert.equal(sessionDays({ SESSION_DAYS: '3.2' }), 4); // rounds up, never down
  assert.equal(sessionDays({ SESSION_DAYS: '30' }), 30);
  assert.equal(sessionDays({ SESSION_DAYS: '31' }), 30);
  assert.equal(sessionDays({ SESSION_DAYS: '365' }), 30);
});

test('getSession verifies request end-to-end', async () => {
  const exp = Date.now() + 60_000;
  const token = await signSession({ v: 1, mr: 'ff', dn: '', exp }, SECRET);
  const req = { headers: { get: (h) => h === 'Cookie' ? `__Host-vjm_session=${token}` : null } };
  const payload = await getSession(req, env);
  assert.ok(payload && payload.mr === 'ff');
  assert.equal(await getSession(req, {}), null);
});

// ---------------------------------------------------------------------------
// Entitlement state + mid-session revocation (migration 0006).
//
// The leak these tests exist for: the session cookie is a stateless bearer
// token good for up to 30 days, so before this check a cancellation reached a
// member who was already signed in only when their cookie happened to expire.
// A canceled customer kept every paid page for up to a month.
// ---------------------------------------------------------------------------

const MR = 'a'.repeat(16);
const liveRow = (over = {}) => ({ status: 'active', expires_at: null, session_epoch: 1, ...over });

// A D1 fake that serves one row for the member_ref lookup.
function refDb(row) {
  return { RESEARCH_DB: { prepare() { return { bind() { return { async first() { return row; } }; } }; } } };
}

async function cookieRequest(payload) {
  const token = await signSession(payload, SECRET);
  return { headers: { get: (h) => (h === 'Cookie' ? `__Host-vjm_session=${token}` : null) } };
}

test('entitlementRowState treats only known-live statuses as entitlement', () => {
  for (const status of LIVE_ENTITLEMENT_STATUSES) {
    assert.equal(entitlementRowState(liveRow({ status })).live, true, status);
  }
  // Case and stray whitespace are normalized — the Sheet-era vocabulary is
  // hand-typed, and 'Active ' meaning nothing would be a footgun, not safety.
  assert.equal(entitlementRowState(liveRow({ status: ' Active ' })).live, true);
  // Everything else fails closed — an allowlist, not a "not revoked" test.
  for (const status of ['revoked', 'pending', 'cancelled', '', null, undefined, 'superuser']) {
    assert.equal(entitlementRowState(liveRow({ status })).live, false, String(status));
  }
  assert.equal(entitlementRowState(null).live, false);
  assert.equal(entitlementRowState(null).reason, 'no_row');
});

test('entitlementRowState refuses a record whose expiry has passed', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(entitlementRowState(liveRow({ expires_at: past })).reason, 'expired');
  assert.equal(entitlementRowState(liveRow({ expires_at: future })).live, true);
  // An unparseable expiry is not silently read as "never expires"… it is the
  // absence of a bound, which is what a lifetime plan legitimately looks like;
  // the session cap in the handlers is what bounds those.
  assert.equal(entitlementRowState(liveRow({ expires_at: 'not-a-date' })).live, true);
  assert.equal(entitlementRowState(liveRow({ expires_at: 'not-a-date' })).expiresAt, null);
});

test('memberRefFromCodeHash is the 16-char prefix both sign-in paths share', () => {
  assert.equal(memberRefFromCodeHash('f'.repeat(64)), 'f'.repeat(16));
  assert.equal(memberRefFromCodeHash(null), '');
});

test('a revoked member loses access BEFORE the cookie expires', async () => {
  // A 30-day cookie, signed a moment ago, entirely valid on its own terms.
  const payload = { v: 2, mr: MR, dn: '', t: 'complete', sv: 1, src: 'd1', exp: Date.now() + 30 * 86400_000 };
  const req = await cookieRequest(payload);

  // While the record is live, the session works.
  const live = { ...env, ...refDb(liveRow()) };
  assert.ok(await getSession(req, live), 'a live record must keep the session working');

  // The webhook flips the row and bumps the epoch. The SAME cookie is now dead
  // — no waiting out 30 days.
  const revoked = { ...env, ...refDb(liveRow({ status: 'revoked', session_epoch: 2 })) };
  assert.equal(await getSession(req, revoked), null, 'a revoked record must kill the live session');
  assert.equal((await sessionEntitlementCheck(payload, revoked)).reason, 'revoked');

  // Its signature is still perfectly valid — the cookie itself did not change.
  // Proving that pins WHERE the refusal comes from: the D1 record, not expiry.
  assert.ok(await verifySessionCookie(req, live), 'the cookie itself is still well-formed and unexpired');
});

test('an epoch bump alone kills outstanding cookies without revoking the row', async () => {
  const payload = { v: 2, mr: MR, dn: '', t: 'complete', sv: 1, src: 'd1', exp: Date.now() + 86400_000 };
  const req = await cookieRequest(payload);
  const bumped = { ...env, ...refDb(liveRow({ session_epoch: 5 })) };
  assert.equal(await getSession(req, bumped), null);
  assert.equal((await sessionEntitlementCheck(payload, bumped)).reason, 'stale_epoch');
  // A session minted AFTER the bump is fine.
  assert.equal((await sessionEntitlementCheck({ ...payload, sv: 5 }, bumped)).ok, true);
});

test('an expired record kills the live session too', async () => {
  const payload = { v: 2, mr: MR, dn: '', t: 'complete', sv: 1, src: 'd1', exp: Date.now() + 30 * 86400_000 };
  const req = await cookieRequest(payload);
  const lapsed = { ...env, ...refDb(liveRow({ expires_at: new Date(Date.now() - 1000).toISOString() })) };
  assert.equal(await getSession(req, lapsed), null);
});

test('a D1-minted session whose row vanished fails closed; a Sheet-era one does not', async () => {
  const gone = { ...env, ...refDb(null) };
  const d1Session = { mr: MR, sv: 1, src: 'd1', exp: Date.now() + 86400_000 };
  assert.equal((await sessionEntitlementCheck(d1Session, gone)).ok, false,
    'the row existed when this session was signed; its disappearance is an unexpected state');

  // A Sheet-bridge member has no D1 row by definition — denying them would
  // sign out every legacy paying customer the day this ships.
  const sheetSession = { mr: MR, sv: 0, src: 'sheet', exp: Date.now() + 86400_000 };
  assert.equal((await sessionEntitlementCheck(sheetSession, gone)).ok, true);
  // …until the owner flips the switch that retires the bridge.
  assert.equal((await sessionEntitlementCheck(sheetSession, { ...gone, STRICT_D1_ENTITLEMENTS: 'true' })).ok, false);
});

test('no D1 binding leaves sessions working, and STRICT flips that too', async () => {
  const session = { mr: MR, sv: 1, src: 'd1', exp: Date.now() + 86400_000 };
  assert.equal((await sessionEntitlementCheck(session, {})).ok, true);
  assert.equal((await sessionEntitlementCheck(session, { STRICT_D1_ENTITLEMENTS: 'true' })).ok, false);
});

test('a D1 outage soft-fails by default and hard-fails under STRICT', async () => {
  const broken = { RESEARCH_DB: { prepare() { throw new Error('D1 unavailable'); } } };
  const session = { mr: MR, sv: 1, src: 'd1', exp: Date.now() + 86400_000 };
  const soft = await sessionEntitlementCheck(session, broken);
  assert.equal(soft.ok, true, 'an outage must not sign out every paying member at once');
  assert.equal(soft.reason, 'db_error');
  assert.equal((await sessionEntitlementCheck(session, { ...broken, STRICT_D1_ENTITLEMENTS: 'true' })).ok, false);
});

test('verifySessionCookie does not consult D1 — logout must work for a revoked member', async () => {
  const payload = { v: 2, mr: MR, dn: 'trader', sv: 1, src: 'd1', exp: Date.now() + 86400_000 };
  const req = await cookieRequest(payload);
  const revoked = {
    ...env,
    RESEARCH_DB: { prepare() { throw new Error('must not be consulted by verifySessionCookie'); } },
  };
  const seen = await verifySessionCookie(req, revoked);
  assert.ok(seen && seen.dn === 'trader');
});
