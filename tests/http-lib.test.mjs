// Regression coverage for functions/api/_lib/http.js — the shared
// rate-limit/response/symbol-validation module every functions/api/*.js
// handler imports, and (per the run cycle's own hard rules) the one file
// this site can never regress rate limiting in. Every handler test exercises
// checkRateLimit() only through its in-isolate Map fallback (no test env
// ever sets RATELIMIT_DB), so the D1-persisted path — the one that actually
// holds the limit across isolates in production — had zero coverage of its
// own: the INSERT..ON CONFLICT increment, the count read-back, the
// count===1 sweep of stale buckets, and the "D1 throws -> fall back to
// memory, never fail open" catch. Also pins cleanSymbol's exchange-prefix
// stripping and character allowlist, and the no-store/nosniff response
// headers every JSON reply carries.
import assert from 'node:assert/strict';
import {
  checkRateLimit,
  cleanSymbol,
  clientIp,
  json,
  jsonWithSession,
  jsonClearedSession,
  fetchJsonWithTimeout,
} from '../functions/api/_lib/http.js';

function req(ip, headers = {}) {
  const h = { ...headers };
  if (ip !== undefined) h['CF-Connecting-IP'] = ip;
  return new Request('https://example.com/x', { headers: h });
}

// clientIp: takes CF-Connecting-IP, truncates to 64 chars, else 'unknown'.
{
  assert.equal(clientIp(req('203.0.113.5')), '203.0.113.5');
  assert.equal(clientIp(req(undefined)), 'unknown');
  const long = '9'.repeat(200);
  assert.equal(clientIp(req(long)), long.slice(0, 64));
}

// cleanSymbol: uppercases, strips a leading EXCHANGE: prefix, allows the
// index-symbol '^' and '.', rejects anything outside that set or too long.
{
  assert.equal(cleanSymbol('aapl'), 'AAPL');
  assert.equal(cleanSymbol('  aapl  '), 'AAPL');
  assert.equal(cleanSymbol('nasdaq:aapl'), 'AAPL');
  assert.equal(cleanSymbol('NYSE:BRK.B'), 'BRK.B');
  assert.equal(cleanSymbol('^gspc'), '^GSPC');
  assert.equal(cleanSymbol(''), null);
  assert.equal(cleanSymbol(null), null);
  assert.equal(cleanSymbol('AAPL; DROP TABLE'), null);
  assert.equal(cleanSymbol('TOOLONGSYMBOL'), null);
  assert.equal(cleanSymbol('<script>'), null);
}

// json/jsonWithSession/jsonClearedSession: every reply is no-store + nosniff
// JSON, and only the session variants set a cookie.
{
  const plain = json({ ok: true });
  assert.equal(plain.headers.get('Cache-Control'), 'no-store');
  assert.equal(plain.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(plain.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(plain.headers.get('Set-Cookie'), null);

  const withSession = jsonWithSession({ ok: true }, 'tok.sig', 3600);
  assert.match(withSession.headers.get('Set-Cookie'), /^__Host-vjm_session=tok\.sig;/);
  assert.match(withSession.headers.get('Set-Cookie'), /Max-Age=3600/);

  const cleared = jsonClearedSession({ ok: true });
  assert.match(cleared.headers.get('Set-Cookie'), /Max-Age=0/);
}

// checkRateLimit, in-isolate Map fallback (no RATELIMIT_DB): counts up per
// scope+IP+identifier bucket and trips once the count exceeds the limit.
{
  const scope = 'lib-test-mem-' + Math.random();
  const r = req('198.51.100.1');
  const first = await checkRateLimit({}, r, scope, 2);
  const second = await checkRateLimit({}, r, scope, 2);
  const third = await checkRateLimit({}, r, scope, 2);
  assert.deepEqual([first.allowed, second.allowed, third.allowed], [true, true, false]);
  assert.deepEqual([first.count, second.count, third.count], [1, 2, 3]);

  // A different identifier under the same scope+IP is a separate bucket.
  const other = await checkRateLimit({}, r, scope, 2, 'AAPL');
  assert.equal(other.allowed, true);
  assert.equal(other.count, 1);
}

// checkRateLimit, in-isolate Map fallback: the per-minute window actually
// rolls over. Every handler test above only ever calls this within a single
// real-time minute, so nothing had pinned that a client's count resets on
// the next minute instead of compounding forever (which would eventually
// lock out a legitimate client) or never resetting fewer than would allow
// (which would fail to enforce the limit at all) — the one invariant this
// module exists to guarantee, per the run cycle's own hard rule against
// weakening rate limiting.
{
  const scope = 'lib-test-mem-rollover-' + Math.random();
  const r = req('198.51.100.4');
  const originalNow = Date.now;
  try {
    const baseMs = 1_000_000 * 60_000; // an arbitrary whole-minute boundary
    Date.now = () => baseMs;
    const first = await checkRateLimit({}, r, scope, 2);
    const second = await checkRateLimit({}, r, scope, 2);
    assert.deepEqual([first.allowed, second.allowed], [true, true]);
    assert.deepEqual([first.count, second.count], [1, 2]);

    Date.now = () => baseMs + 60_000; // next minute
    const third = await checkRateLimit({}, r, scope, 2);
    assert.equal(third.allowed, true, 'window must reset on the new minute, not stay tripped');
    assert.equal(third.count, 1, 'count must restart at 1, not compound to 3');
  } finally {
    Date.now = originalNow;
  }
}

// checkRateLimit, in-isolate Map fallback: the minute-rollover guard for when
// the function's two internal Date.now() reads (once inside bucketKey to
// embed the minute in the map key, once more for the local `minute` used to
// judge staleness) straddle a real minute boundary. The map key already
// bakes the minute in, so a lookup under a key built from the *older* read
// can only ever return an entry stored under that same older minute — this
// mismatch is the only case this reset guard exists for, and no prior test
// ever forced the two reads apart, so it had zero coverage. Mocks Date.now
// to advance mid-call rather than waiting for a real boundary race.
{
  const scope = 'lib-test-mem-boundary-race-' + Math.random();
  const r = req('198.51.100.9');
  const originalNow = Date.now;
  try {
    const baseMs = 2_000_000 * 60_000;
    Date.now = () => baseMs;
    const primed = await checkRateLimit({}, r, scope, 5);
    assert.equal(primed.count, 1);

    let call = 0;
    Date.now = () => (call++ === 0 ? baseMs : baseMs + 60_000);
    const raced = await checkRateLimit({}, r, scope, 5);
    assert.equal(raced.allowed, true);
    assert.equal(raced.count, 1, 'a stale entry surfaced across the boundary must reset, not compound to 2');
  } finally {
    Date.now = originalNow;
  }
}

// checkRateLimit, D1-backed path: the actual production persistence layer.
// Verify the increment SQL runs, the returned count drives the allowed
// decision, and the stale-bucket sweep fires only on the bucket's first hit
// (count === 1) so it isn't re-run on every single request.
{
  const scope = 'lib-test-d1-' + Math.random();
  const r = req('198.51.100.2');
  const rows = new Map();
  const calls = [];
  const env = {
    RATELIMIT_DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              run: async () => {
                if (/INSERT INTO rate_limits/.test(sql)) {
                  const [bucket] = args;
                  rows.set(bucket, (rows.get(bucket) || 0) + 1);
                } else if (/DELETE FROM rate_limits/.test(sql)) {
                  // stale-row sweep; nothing to simulate against a single row.
                }
                return { success: true };
              },
              first: async () => {
                const [bucket] = args;
                return rows.has(bucket) ? { count: rows.get(bucket) } : null;
              },
            };
          },
        };
      },
    },
  };

  const first = await checkRateLimit(env, r, scope, 2);
  const second = await checkRateLimit(env, r, scope, 2);
  const third = await checkRateLimit(env, r, scope, 2);
  assert.deepEqual([first.allowed, second.allowed, third.allowed], [true, true, false]);
  assert.deepEqual([first.count, second.count, third.count], [1, 2, 3]);

  const deletes = calls.filter((c) => /DELETE FROM rate_limits/.test(c.sql));
  assert.equal(deletes.length, 1, 'sweep must run exactly once, on the bucket\'s first hit');
}

// checkRateLimit, D1 throws (misconfigured table, outage): must fall back to
// the in-isolate memory limiter rather than failing open (unlimited) or
// throwing out of the endpoint.
{
  const scope = 'lib-test-d1-fail-' + Math.random();
  const r = req('198.51.100.3');
  const env = {
    RATELIMIT_DB: {
      prepare() {
        throw new Error('D1 unavailable');
      },
    },
  };
  const first = await checkRateLimit(env, r, scope, 1);
  const second = await checkRateLimit(env, r, scope, 1);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false, 'must still enforce the limit via the memory fallback, not fail open');
}

// fetchJsonWithTimeout: aborts a hung request at the given timeout instead
// of hanging the endpoint forever.
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    await assert.rejects(
      () => fetchJsonWithTimeout('https://example.com/slow', 10),
      /AbortError|aborted/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('VJM http-lib tests passed.');
