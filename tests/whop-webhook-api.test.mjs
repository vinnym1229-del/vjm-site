// Regression coverage for /api/whop-webhook (functions/api/whop-webhook.js).
//
// This is the payment-automation endpoint: it turns a Whop purchase/refund
// webhook into a minted or revoked access code, and it was the last
// functions/api/*.js file with zero test references despite handling real
// money. Two invariants the handler's own comments already document but
// nothing pinned:
//   1. A revoke event with no member id must fail CLOSED (422, claim
//      released for retry) rather than being recorded as handled while
//      access silently stays live — the code explicitly calls this out as
//      "fail-open on revocation" if skipped.
//   2. An undeliverable grant (no Discord channel configured, or the
//      delivery post itself fails) must delete the pending code row and
//      release the idempotency claim, never leave a paying customer with a
//      code nobody can recover. Only the row's hash is persisted, so a code
//      that isn't delivered now is gone forever unless the claim is freed
//      for Whop's retry to mint a fresh one.
// Also pins signature/timestamp verification and the atomic INSERT-OR-IGNORE
// idempotency claim (a duplicate delivery of one event must not mint two
// codes).
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/whop-webhook.js';

const SECRET = 'whsec_test_secret';
const HOOK = 'https://discord.com/api/webhooks/123/abc';

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Minimal D1 fake covering exactly the queries whop-webhook.js issues,
// matched by a distinguishing substring of each SQL statement. State lives
// in the Maps/Sets passed in so a test can assert on it directly.
function makeDb({ claimedEvents = new Set(), codes = new Map() } = {}) {
  return {
    claimedEvents,
    codes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return null; },
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO webhook_events')) {
                const [eventId] = args;
                const key = 'whop:' + eventId;
                if (claimedEvents.has(key)) return { meta: { changes: 0 } };
                claimedEvents.add(key);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM webhook_events')) {
                const [, eventId] = args;
                claimedEvents.delete('whop:' + eventId);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO whop_codes')) {
                const [hash, last4, eventId, memberId] = args;
                if (!codes.has(hash)) {
                  codes.set(hash, { code_last4: last4, whop_event_id: eventId, whop_member_id: memberId, status: 'pending' });
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM whop_codes')) {
                const [hash] = args;
                const existed = codes.delete(hash);
                return { meta: { changes: existed ? 1 : 0 } };
              }
              if (sql.includes("UPDATE whop_codes SET status='delivered'")) {
                const [hash] = args;
                const row = codes.get(hash);
                if (row) row.status = 'delivered';
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE whop_codes SET status='revoked'")) {
                const [memberId] = args;
                let changes = 0;
                for (const row of codes.values()) {
                  if (row.whop_member_id === memberId && row.status !== 'revoked') { row.status = 'revoked'; changes++; }
                }
                return { meta: { changes } };
              }
              if (sql.includes('UPDATE webhook_events')) {
                return { meta: { changes: 1 } };
              }
              throw new Error('unhandled query in fake D1: ' + sql);
            },
          };
        },
      };
    },
  };
}

function baseEnv(db) {
  return { WHOP_WEBHOOK_SECRET: SECRET, RESEARCH_DB: db || makeDb() };
}

async function postWebhook(env, bodyObj, { ts = Math.floor(Date.now() / 1000), sign = true, raw } = {}) {
  const rawBody = raw !== undefined ? raw : JSON.stringify(bodyObj);
  const headers = {};
  if (sign && env.WHOP_WEBHOOK_SECRET) {
    const tsHeader = String(ts);
    headers['x-whop-signature'] = await hmacHex(env.WHOP_WEBHOOK_SECRET, `${tsHeader}.${rawBody}`);
    headers['x-whop-timestamp'] = tsHeader;
  }
  const res = await onRequestPost({
    request: new Request('https://example.com/api/whop-webhook', { method: 'POST', headers, body: rawBody }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

function grantBody(eventId, memberId = 'user_1') {
  return { type: 'membership.went_valid', id: eventId, data: { membership: { user_id: memberId, product_id: 'prod_1' } } };
}
function revokeBody(eventId, memberId) {
  return { type: 'membership.went_invalid', id: eventId, data: memberId ? { membership: { user_id: memberId } } : {} };
}

const originalFetch = globalThis.fetch;

// Missing config fails closed before touching the body.
{
  const { status } = await postWebhook({ RESEARCH_DB: makeDb() }, grantBody('e1'));
  assert.equal(status, 503);
}
{
  const { status } = await postWebhook({ WHOP_WEBHOOK_SECRET: SECRET }, grantBody('e2'));
  assert.equal(status, 503);
}

// Oversized body rejected before signature verification even runs.
{
  const res = await onRequestPost({
    request: new Request('https://example.com/api/whop-webhook', { method: 'POST', body: 'x'.repeat(70000) }),
    env: baseEnv(),
  });
  assert.equal(res.status, 413);
}

// Missing signature/timestamp headers.
{
  const { status, data } = await postWebhook(baseEnv(), grantBody('e3'), { sign: false });
  assert.equal(status, 401);
  assert.match(data.error, /missing signature/);
}

// Stale timestamp (outside the 5-minute tolerance) is rejected even with a
// correctly computed signature for that timestamp.
{
  const { status, data } = await postWebhook(baseEnv(), grantBody('e4'), { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(status, 401);
  assert.match(data.error, /stale timestamp/);
}

// Wrong secret produces a signature that fails comparison.
{
  const env = baseEnv();
  const rawBody = JSON.stringify(grantBody('e5'));
  const ts = String(Math.floor(Date.now() / 1000));
  const badSig = await hmacHex('wrong-secret', `${ts}.${rawBody}`);
  const res = await onRequestPost({
    request: new Request('https://example.com/api/whop-webhook', {
      method: 'POST',
      headers: { 'x-whop-signature': badSig, 'x-whop-timestamp': ts },
      body: rawBody,
    }),
    env,
  });
  const data = await res.json();
  assert.equal(res.status, 401);
  assert.match(data.error, /invalid signature/);
}

// Valid signature over malformed JSON.
{
  const { status, data } = await postWebhook(baseEnv(), null, { raw: 'not-json' });
  assert.equal(status, 400);
  assert.match(data.error, /bad json/);
}

// Unrecognized event type: acknowledged, ignored, no side effects.
{
  const { status, data } = await postWebhook(baseEnv(), { type: 'something.else', id: 'e6' });
  assert.equal(status, 200);
  assert.equal(data.ignored, true);
}

try {
  // Full grant lifecycle: signature verified, code minted, delivered via
  // Discord, status flipped to 'delivered'. A second delivery of the SAME
  // event id must be recognized as a duplicate and mint nothing new.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });

    const first = await postWebhook(env, grantBody('grant-1', 'member-A'));
    assert.equal(first.status, 200);
    assert.equal(first.data.action, 'grant');
    assert.equal(first.data.delivered, true);
    assert.equal(db.codes.size, 1);
    assert.equal([...db.codes.values()][0].status, 'delivered');

    const dupe = await postWebhook(env, grantBody('grant-1', 'member-A'));
    assert.equal(dupe.status, 200);
    assert.equal(dupe.data.duplicate, true);
    assert.equal(db.codes.size, 1, 'a replayed event must not mint a second code');
  }

  // Grant with no Discord delivery channel configured: the code can never
  // reach the owner, so the pending row must be deleted and the claim
  // released so Whop's retry (once configured) mints a fresh, deliverable
  // code instead of the customer being left with an unrecoverable one.
  {
    const db = makeDb();
    const env = baseEnv(db); // no DISCORD_WHOP_CODES_WEBHOOK
    const { status, data } = await postWebhook(env, grantBody('grant-2', 'member-B'));
    assert.equal(status, 503);
    assert.match(data.error, /not configured/);
    assert.equal(db.codes.size, 0, 'undeliverable code must not be left in the table');
    assert.equal(db.claimedEvents.size, 0, 'claim must be released so a retry can reprocess this event');
  }

  // Grant with delivery channel configured but the Discord post itself
  // fails (e.g. rate-limited): same fail-safe as above, not a silent grant.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 429 });
    const { status, data } = await postWebhook(env, grantBody('grant-3', 'member-C'));
    assert.equal(status, 503);
    assert.match(data.error, /will retry/);
    assert.equal(db.codes.size, 0);
    assert.equal(db.claimedEvents.size, 0);
  }

  // Revoke with no member id on the event: this must fail CLOSED (422) and
  // release the claim, never be silently recorded as handled while whatever
  // code that member holds stays active.
  {
    const db = makeDb();
    const env = baseEnv(db);
    const { status, data } = await postWebhook(env, revokeBody('revoke-1', null));
    assert.equal(status, 422);
    assert.equal(data.ok, false);
    assert.equal(db.claimedEvents.size, 0, 'claim must be released, not left marked handled');
  }

  // Revoke with a valid member id flips their delivered code(s) to revoked
  // and reports how many rows changed.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await postWebhook(env, grantBody('grant-4', 'member-D'));
    assert.equal([...db.codes.values()][0].status, 'delivered');

    const { status, data } = await postWebhook(env, revokeBody('revoke-2', 'member-D'));
    assert.equal(status, 200);
    assert.equal(data.action, 'revoke');
    assert.equal(data.revoked, 1);
    assert.equal([...db.codes.values()][0].status, 'revoked');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM whop-webhook API tests passed.');
