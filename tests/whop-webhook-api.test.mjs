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
function makeDb({ claimedEvents = new Set(), codes = new Map(), notes = new Map() } = {}) {
  return {
    claimedEvents,
    codes,
    notes,
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
                const [hash, last4, eventId, memberId, product] = args;
                const emailHash = args[5];   // ?6
                const tier = args[10];       // ?11 — migration 0005
                const memberRef = args[11];  // ?12 — migration 0006
                const provisionedAt = args[12]; // ?13
                // status is a literal 'active' in the SQL (migration 0006):
                // provisioning is transactional, not a later UPDATE.
                assert.match(sql, /VALUES \(\?1, \?2, \?3, \?4, \?5, 'active'/,
                  'the grant insert must provision as active in one write');
                if (!codes.has(hash)) {
                  codes.set(hash, {
                    code_hash: hash, code_last4: last4, whop_event_id: eventId,
                    whop_member_id: memberId, whop_product: product, email_hash: emailHash,
                    tier, member_ref: memberRef, provisioned_at: provisionedAt,
                    session_epoch: 1, status: 'active',
                  });
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM whop_codes')) {
                const [hash] = args;
                const existed = codes.delete(hash);
                return { meta: { changes: existed ? 1 : 0 } };
              }
              if (sql.includes("SET status='revoked'")) {
                // Apply only what the statement actually says. The epoch bump
                // is the part that reaches an already-signed-in member, so the
                // fake must not perform it out of politeness — drop it from
                // the SQL and this test has to go red.
                const bumpsEpoch = /session_epoch\s*=\s*session_epoch\s*\+\s*1/.test(sql);
                const [memberId, revokedAt] = args;
                let changes = 0;
                for (const row of codes.values()) {
                  if (row.whop_member_id === memberId && row.status !== 'revoked') {
                    row.status = 'revoked';
                    row.revoked_at = revokedAt;
                    if (bumpsEpoch) row.session_epoch = (Number(row.session_epoch) || 1) + 1;
                    changes++;
                  }
                }
                return { meta: { changes } };
              }
              if (sql.includes('UPDATE webhook_events')) {
                const [eventId, note] = args;
                notes.set(eventId, note === undefined ? 'revoke' : note);
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

function grantBody(eventId, memberId = 'user_1', productId = 'prod_1', planId = null, email = null) {
  const membership = { user_id: memberId, product_id: productId };
  if (planId) membership.plan_id = planId;
  if (email) membership.user = { email };
  return { type: 'membership.went_valid', id: eventId, data: { membership } };
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
    // Provisioned, not "pending until a human copies the code into a sheet":
    // the row is live the instant the webhook lands, and it carries the
    // member_ref the session's revocation check looks a member up by.
    const row = [...db.codes.values()][0];
    assert.equal(row.status, 'active');
    assert.equal(first.data.provisioned, true);
    assert.equal(row.member_ref, row.code_hash.slice(0, 16),
      'member_ref must be the prefix the session mr claim carries (migration 0006)');
    assert.equal(row.session_epoch, 1);
    assert.ok(row.provisioned_at, 'provisioning time must be recorded transactionally with the grant');

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
    assert.equal([...db.codes.values()][0].status, 'active');

    const { status, data } = await postWebhook(env, revokeBody('revoke-2', 'member-D'));
    assert.equal(status, 200);
    assert.equal(data.action, 'revoke');
    assert.equal(data.revoked, 1);
    const revoked = [...db.codes.values()][0];
    assert.equal(revoked.status, 'revoked');
    // The epoch bump is what reaches a member who is ALREADY signed in: the
    // cookie they hold was signed with epoch 1, the row now says 2, so
    // _lib/session.js refuses it long before the cookie's own expiry.
    assert.equal(revoked.session_epoch, 2, 'a revoke must bump the session epoch, not only the status');
    assert.ok(revoked.revoked_at);
  }

  // A grant that cannot deliver its code but DOES carry an email is still a
  // provisioned membership: the customer can sign in with Google (which
  // matches on email_hash and never needs a code), so tearing down their live
  // entitlement over a failed Discord post would be the worse outcome.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 500 });
    const { status, data } = await postWebhook(
      env, grantBody('grant-email', 'member-E', 'prod_1', null, 'buyer@example.com')
    );
    assert.equal(status, 200);
    assert.equal(data.delivered, false);
    assert.equal(data.provisioned, true);
    assert.equal(db.codes.size, 1, 'an email-backed grant survives a failed code delivery');
    assert.equal([...db.codes.values()][0].status, 'active');
    assert.match(db.notes.get('grant-email'), /undelivered_email_fallback/);
  }
  // ─────────────────────────────────────────────────────────────────────
  // Entitlement tier (functions/api/_lib/entitlements.js + migration 0005).
  //
  // The site sells $100 Futures Only and $129 Complete. Until now every
  // grant was identical, so any purchase became a full-library credential.
  // The webhook now resolves the event's product/plan to a tier and refuses
  // to grant at all when it resolves to none.
  // ─────────────────────────────────────────────────────────────────────
  const ALLOWLIST = {
    WHOP_PRODUCTS_FUTURES: 'prod_futures_100, plan_futures_monthly',
    WHOP_PRODUCTS_COMPLETE: 'prod_complete_129',
  };

  // The core rejection: a product that is not on either allowlist — a cheaper
  // item, a standalone indicator, another storefront's product — reaches this
  // endpoint with a PERFECTLY VALID signature. It must grant nothing: no code
  // row, no Discord delivery, no credential of any kind.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), ...ALLOWLIST, DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    let posted = 0;
    globalThis.fetch = async () => { posted += 1; return new Response(null, { status: 204 }); };

    const { status, data } = await postWebhook(env, grantBody('tier-reject-1', 'member-X', 'prod_indicator_29'));
    // Acked, not retried: a non-2xx makes Whop redeliver this event forever
    // and no retry can change the answer.
    assert.equal(status, 200);
    assert.equal(data.granted, false);
    assert.equal(data.reason, 'not_allowlisted');
    assert.equal(db.codes.size, 0, 'an unallowlisted product must not mint a code row');
    assert.equal(posted, 0, 'no code may be delivered for a product that grants nothing');
    // The claim stays, so Whop's retries are cheap duplicates, and the reason
    // is written to the row the owner can actually read.
    assert.equal(db.claimedEvents.size, 1, 'the event stays claimed — retrying it can never grant');
    assert.match(db.notes.get('tier-reject-1'), /no_grant:not_allowlisted:prod_indicator_29/);
  }

  // An event carrying no product id at all is likewise not a credential.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), ...ALLOWLIST, DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => { throw new Error('must not deliver a code for an unidentified product'); };
    const body = { type: 'membership.went_valid', id: 'tier-reject-2', data: { membership: { user_id: 'member-Y' } } };
    const { status, data } = await postWebhook(env, body);
    assert.equal(status, 200);
    assert.equal(data.reason, 'no_product_id');
    assert.equal(db.codes.size, 0);
  }

  // The allowlisted $100 futures product mints futures_core — NOT complete.
  // This is the row the session's signed tier claim is later read from, so
  // this single value is what stops a $100 buyer reaching the $129 library.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), ...ALLOWLIST, DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const { status, data } = await postWebhook(env, grantBody('tier-futures', 'member-F', 'prod_futures_100'));
    assert.equal(status, 200);
    assert.equal(data.tier, 'futures_core');
    assert.equal([...db.codes.values()][0].tier, 'futures_core',
      'the $100 futures product must be persisted as futures_core, not complete');
    assert.match(db.notes.get('tier-futures'), /grant:futures_core/);
  }

  // Whop sends a plan id (not a product id) on some events; the futures plan
  // must resolve the same way rather than falling through to "no tier".
  {
    const db = makeDb();
    const env = { ...baseEnv(db), ...ALLOWLIST, DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const { data } = await postWebhook(env, grantBody('tier-plan', 'member-P', 'prod_unlisted', 'plan_futures_monthly'));
    assert.equal(data.tier, 'futures_core');
  }

  // The $129 product mints complete.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), ...ALLOWLIST, DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const { data } = await postWebhook(env, grantBody('tier-complete', 'member-C2', 'prod_complete_129'));
    assert.equal(data.tier, 'complete');
    assert.equal([...db.codes.values()][0].tier, 'complete');
  }

  // A deployment with no allowlists configured must keep granting exactly as
  // it did before this change, so shipping the tier model does not black out
  // live purchases before the owner sets the env vars.
  {
    const db = makeDb();
    const env = { ...baseEnv(db), DISCORD_WHOP_CODES_WEBHOOK: HOOK };
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const { status, data } = await postWebhook(env, grantBody('tier-unconfigured', 'member-U', 'prod_whatever'));
    assert.equal(status, 200);
    assert.equal(data.tier, 'complete', 'unconfigured deployments keep the pre-tier behaviour');
    assert.equal([...db.codes.values()][0].tier, 'complete');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM whop-webhook API tests passed.');
