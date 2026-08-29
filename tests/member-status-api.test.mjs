// Regression coverage for /api/check-member-status (functions/api/check-member-status.js).
//
// The handler's own comment promises a "generic response that does not
// reveal whether a handle exists on the sheet vs is inactive" — but that
// promise was never pinned by a test, so a future edit (e.g. echoing the
// upstream status string, or branching the message on "found vs not found")
// could reopen a membership-enumeration side channel silently. This test
// module was the only functions/api/*.js file with zero test references.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/check-member-status.js';

async function lookup(env, discord) {
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/check-member-status?discord=${encodeURIComponent(discord)}`),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// Not configured: neither MEMBERS_STATUS_URL nor the bridge pair is set.
{
  const { status, data } = await lookup({}, 'trader1');
  assert.equal(status, 503);
  assert.equal(data.ok, false);
}

// Malformed handles are rejected before any lookup happens.
{
  const env = { MEMBERS_STATUS_URL: 'https://example.com/status.json' };
  for (const bad of ['', '  ', 'a', 'has a space', 'semi;colon', '@'.repeat(40)]) {
    const { status, data } = await lookup(env, bad);
    assert.equal(status, 400, `expected 400 for "${bad}"`);
    assert.equal(data.ok, false);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({
  ok: true,
  statuses: { activeuser: 'active', renewed_user: 'renewed', lapsed_user: 'expired' },
});

try {
  const env = { MEMBERS_STATUS_URL: 'https://example.com/status.json' };

  const active = await lookup(env, 'activeuser');
  assert.equal(active.status, 200);
  assert.equal(active.data.active, true);

  const renewed = await lookup(env, 'renewed_user');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.active, true);

  // A handle present on the sheet but not active, and a handle absent from
  // the sheet entirely, must be indistinguishable to the caller: same
  // status code, same "active" flag, same message text.
  const lapsed = await lookup(env, 'lapsed_user');
  const unknown = await lookup(env, 'never_seen_before');
  assert.equal(lapsed.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(lapsed.data.active, false);
  assert.equal(unknown.data.active, false);
  assert.equal(lapsed.data.message, unknown.data.message,
    'inactive-but-known and never-seen handles must return the same message (no enumeration leak)');
  assert.equal(lapsed.data.ok, true, 'a not-active lookup is still ok:true — it is a successful, generic answer');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM check-member-status API tests passed.');
