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

// ---------------------------------------------------------------------------
// D1 is the authority; the Sheet is only a fallback (migration 0006).
//
// The Sheet is maintained by hand and always lags a cancellation, so a
// revoked whop_codes row must beat an active Sheet row — otherwise the widget
// keeps telling a canceled customer (and the owner) that they are a member.
// ---------------------------------------------------------------------------

function d1(rows) {
  return {
    prepare() {
      return { bind() { return { async all() { return { results: rows }; } }; } };
    },
  };
}

// The Sheet says active for every handle in this block.
const sheetSaysActive = async () => Response.json({
  ok: true,
  statuses: { revokeduser: 'active', lapseduser: 'active', sheetonly: 'active' },
});

const originalFetch2 = globalThis.fetch;
try {
  globalThis.fetch = sheetSaysActive;
  const SHEET = { MEMBERS_STATUS_URL: 'https://example.com/status.json' };

  // Revoked in D1, Active on the Sheet: D1 wins.
  {
    const env = { ...SHEET, RESEARCH_DB: d1([{ status: 'revoked', expires_at: null, session_epoch: 2 }]) };
    const { status, data } = await lookup(env, 'revokeduser');
    assert.equal(status, 404);
    assert.equal(data.active, false, 'a revoked D1 record must beat an active Sheet row');
  }

  // Expired in D1, Active on the Sheet: D1 wins here too.
  {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const env = { ...SHEET, RESEARCH_DB: d1([{ status: 'active', expires_at: expired, session_epoch: 1 }]) };
    const { status, data } = await lookup(env, 'lapseduser');
    assert.equal(status, 404);
    assert.equal(data.active, false);
  }

  // Live in D1 with no Sheet configured at all: a purchase the webhook
  // provisioned shows as active with no human step in between.
  {
    globalThis.fetch = async () => { throw new Error('no bridge may be contacted when D1 has the answer'); };
    const env = { RESEARCH_DB: d1([{ status: 'active', expires_at: null, session_epoch: 1 }]) };
    const { status, data } = await lookup(env, 'newbuyer');
    assert.equal(status, 200);
    assert.equal(data.active, true);
  }

  // No D1 row: the Sheet is still consulted, so legacy members keep working.
  {
    globalThis.fetch = sheetSaysActive;
    const env = { ...SHEET, RESEARCH_DB: d1([]) };
    const { status, data } = await lookup(env, 'sheetonly');
    assert.equal(status, 200);
    assert.equal(data.active, true);
  }

  // A D1 outage must not be read as "not a member" — it defers to the Sheet
  // rather than telling a paying customer they do not exist.
  {
    globalThis.fetch = sheetSaysActive;
    const env = { ...SHEET, RESEARCH_DB: { prepare() { throw new Error('D1 unavailable'); } } };
    const { status } = await lookup(env, 'sheetonly');
    assert.equal(status, 200);
  }
} finally {
  globalThis.fetch = originalFetch2;
}

console.log('VJM check-member-status API tests passed.');
