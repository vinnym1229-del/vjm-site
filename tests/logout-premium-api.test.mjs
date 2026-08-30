// Regression coverage for /api/logout-premium (functions/api/logout-premium.js).
//
// This was the last session-adjacent functions/api/*.js file with zero test
// references. Its own comments make two promises nothing pinned: the audit
// insert is "best-effort" (a DB failure must never block the logout), and
// the whole handler is wrapped so it "never blocks logout" even if session
// verification itself throws. Both are silent-failure-mode invariants —
// exactly the kind a refactor could break without any test going red. Also
// pins that every response clears the __Host- session cookie byte-for-byte
// (buildClearCookie()'s Max-Age=0), regardless of whether a session existed.
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/logout-premium.js';
import { signSession, buildClearCookie } from '../functions/api/_lib/session.js';

const SECRET = 'x'.repeat(32);

async function logout(env, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await onRequestPost({
    request: new Request('https://example.com/api/logout-premium', { method: 'POST', headers }),
    env,
  });
  const data = await res.json();
  return { status: res.status, data, setCookie: res.headers.get('Set-Cookie') };
}

async function sessionCookie(mr = 'abcd1234abcd1234') {
  const token = await signSession({ v: 1, mr, dn: '', exp: Date.now() + 60000 }, SECRET);
  return `__Host-vjm_session=${token}`;
}

// No cookie, no DB binding: still a clean 200 with the cookie cleared.
{
  const { status, data, setCookie } = await logout({});
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(setCookie, buildClearCookie());
}

// No cookie, but a DB binding present: no session means no audit write is
// even attempted. Prove it by making prepare() throw if called.
{
  const env = {
    RATELIMIT_DB: { prepare() { throw new Error('must not be called with no session'); } },
  };
  const { status, data, setCookie } = await logout(env);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(setCookie, buildClearCookie());
}

// Valid session + working DB: audit row is written with the documented
// shape (event_type='logout', outcome='ok', subject_hash = session.mr
// truncated to 16 chars), and the cookie is still cleared.
{
  const calls = [];
  const env = {
    SESSION_SIGNING_SECRET: SECRET,
    RATELIMIT_DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return { run: async () => ({ success: true }) };
          },
        };
      },
    },
  };
  const cookie = await sessionCookie('abcd1234abcd1234extra');
  const { status, data, setCookie } = await logout(env, cookie);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(setCookie, buildClearCookie());
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO audit_events/);
  assert.deepEqual(calls[0].args, ['logout', 'ok', 'abcd1234abcd1234']);
}

// Valid session but the DB write itself fails (e.g. table missing, D1
// outage): logout is best-effort logging, never a blocked logout.
{
  const env = {
    SESSION_SIGNING_SECRET: SECRET,
    RATELIMIT_DB: {
      prepare() {
        return { bind: () => ({ run: async () => { throw new Error('D1 unavailable'); } }) };
      },
    },
  };
  const cookie = await sessionCookie();
  const { status, data, setCookie } = await logout(env, cookie);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(setCookie, buildClearCookie());
}

// A garbage cookie value must not throw out of the handler either — the
// whole session lookup is wrapped so logout always succeeds.
{
  const env = { SESSION_SIGNING_SECRET: SECRET };
  const { status, data, setCookie } = await logout(env, '__Host-vjm_session=not-a-real-token');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(setCookie, buildClearCookie());
}

console.log('VJM logout-premium API tests passed.');
