// Regression coverage for whop-webhook.js's own documented rollback: when
// pickValidAccessCode exhausts its generate/validate retries -- only
// possible if generateAccessCodeShape and isValidGeneratedCode ever drift
// out of alphabet sync (see integrations-core.js; they have drifted once
// before) -- the grant handler must release the idempotency claim and
// answer 503, never mint a code that fails its own validator and leave a
// paying customer with one nobody, including them, could ever sign in with.
//
// Nothing pinned this: the call site never passes generate/isValid
// overrides, so forcing the failure needs pickValidAccessCode itself
// replaced under the handler. Node's module mocking (node
// --experimental-test-module-mocks, see package.json's test script) makes
// that possible for the first time -- mock the dependency, then import a
// fresh copy of the handler that resolves it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhopEvent, timingSafeHexEqual } from '../functions/api/_lib/integrations-core.js';

const SECRET = 'whsec_test_secret';

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fake D1 covering only the two queries reachable before code generation:
// the idempotency claim and, on failure, its release.
function makeDb() {
  const claimedEvents = new Set();
  return {
    claimedEvents,
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
              throw new Error('unhandled query in fake D1: ' + sql);
            },
          };
        },
      };
    },
  };
}

function grantBody(eventId, memberId = 'user_1', productId = 'prod_1') {
  return { type: 'membership.went_valid', id: eventId, data: { membership: { user_id: memberId, product_id: productId } } };
}

test('grant handler releases its claim and answers 503 when code generation cannot produce a valid code', async () => {
  mock.module('../functions/api/_lib/integrations-core.js', {
    namedExports: { normalizeWhopEvent, timingSafeHexEqual, pickValidAccessCode: () => null },
  });
  const { onRequestPost } = await import('../functions/api/whop-webhook.js');

  const db = makeDb();
  const env = { WHOP_WEBHOOK_SECRET: SECRET, RESEARCH_DB: db };
  const eventId = 'evt_code_gen_fail';
  const rawBody = JSON.stringify(grantBody(eventId));
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-whop-signature': await hmacHex(SECRET, `${ts}.${rawBody}`), 'x-whop-timestamp': ts };

  const res = await onRequestPost({
    request: new Request('https://example.com/api/whop-webhook', { method: 'POST', headers, body: rawBody }),
    env,
  });

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /retry/i);
  // The claim must be released, not left stuck -- otherwise Whop's retry of
  // this same event id is treated as a duplicate and never tries again.
  assert.equal(db.claimedEvents.has('whop:' + eventId), false);
});
