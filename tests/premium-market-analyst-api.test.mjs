// Regression coverage for GET /api/premium-market-analyst (functions/api/premium-market-analyst.js).
//
// This was the last payment-gated functions/api/*.js file with zero test
// references. It's premium session-cookie-only (no legacy Bearer path, unlike
// premium-stock-research.js), so an auth regression here would leak the paid
// AI trend analyst to anyone. It also has its own documented fixed bug in the
// metrics block: `lastClose > null` coerces to `lastClose > 0`, which reads
// as "price is above its average" for every symbol with under 200 bars of
// history unless aboveSma50/aboveSma200 are explicitly null-guarded when the
// average itself isn't computable yet -- pins that guard directly.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/premium-market-analyst.js';
import { signSession } from '../functions/api/_lib/session.js';
import { TIERS, SESSION_VERSION } from '../functions/api/_lib/entitlements.js';

const SIGNING_SECRET = 'x'.repeat(32);

function baseEnv(extra = {}) {
  return { SESSION_SIGNING_SECRET: SIGNING_SECRET, ALPACA_API_KEY: 'key', ALPACA_SECRET_KEY: 'secret', ...extra };
}

async function sessionCookieHeader() {
  const token = await signSession({ exp: Date.now() + 60000 }, SIGNING_SECRET);
  return { Cookie: `__Host-vjm_session=${token}` };
}

// Builds `n` synthetic daily bars with closes rising linearly from `start`,
// one calendar day apart -- enough to drive sma50/sma200 either side of the
// null-guard boundary.
function makeBars(n, start = 100) {
  const bars = [];
  const base = new Date('2024-01-02T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    bars.push({ t: d.toISOString(), c: start + i });
  }
  return bars;
}

// Builds bars that rise for `riseN` days then decline for `fallN`, so
// computeMetrics() sees a real peak-then-drawdown instead of the monotonic
// rise every other fixture in this file produces.
function makeDeclineBars(riseN, fallN, start = 100) {
  const closes = [];
  for (let i = 0; i < riseN; i++) closes.push(start + i);
  const peak = closes[closes.length - 1];
  for (let i = 1; i <= fallN; i++) closes.push(peak - i);
  const base = new Date('2024-01-02T00:00:00Z');
  return closes.map((c, i) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    return { t: d.toISOString(), c };
  });
}

let ipCounter = 0;
async function analyze(env, years, headers = {}) {
  ipCounter += 1;
  const url = years === undefined
    ? 'https://example.com/api/premium-market-analyst'
    : `https://example.com/api/premium-market-analyst?years=${years}`;
  const res = await onRequestGet({
    request: new Request(url, { headers: { 'CF-Connecting-IP': `10.4.0.${ipCounter}`, ...headers } }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// No session cookie: rejected before any upstream call or years validation.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca without authorization'); };
  try {
    const { status, data } = await analyze(baseEnv(), 99);
    assert.equal(status, 401);
    assert.equal(data.error, 'A premium session is required.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Tampered session cookie (bad signature) is rejected.
{
  const { status } = await analyze(baseEnv(), 3, { Cookie: '__Host-vjm_session=garbage.notasignature' });
  assert.equal(status, 401);
}

// SESSION_SIGNING_SECRET itself missing (an owner misconfiguration, distinct
// from a merely tampered cookie) fails closed at the very first check --
// resolveSigningSecret() returns null before a cookie is even read.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca with no signing secret configured'); };
  try {
    const { status, data } = await analyze(
      { ALPACA_API_KEY: 'key', ALPACA_SECRET_KEY: 'secret' }, 3, await sessionCookieHeader(),
    );
    assert.equal(status, 401);
    assert.equal(data.error, 'A premium session is required.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Authenticated but years outside the allowed set (1/3/5) is rejected.
{
  const { status, data } = await analyze(baseEnv(), 4, await sessionCookieHeader());
  assert.equal(status, 400);
  assert.equal(data.ok, false);
}

// Authenticated, valid years, Alpaca not configured: fails closed (503)
// before any upstream call.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca without keys configured'); };
  try {
    const { status, data } = await analyze(
      { SESSION_SIGNING_SECRET: SIGNING_SECRET }, 3, await sessionCookieHeader()
    );
    assert.equal(status, 503);
    assert.equal(data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalFetch = globalThis.fetch;
try {
  // Fewer than 60 returned bars is treated as insufficient history, not a
  // fabricated readout off a handful of days.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(10) } });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 502);
    assert.equal(data.ok, false);
  }

  // The symbol key present but not an actual array (this exact shape has
  // drifted once before, per _lib/alpaca.js) must fall back to null and fail
  // the same insufficient-history guard -- not treat an array-like object's
  // `.length` as real history and crash later in computeMetrics()'s `.map`.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: { length: 100 } } });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 502);
    assert.equal(data.detail, 'insufficient history returned');
  }

  // Upstream HTTP error surfaces as 502 with the specific "upstream status N"
  // detail -- proving the `!res.ok` guard fired, not that JSON.parse happened
  // to fail on a non-JSON error body for an unrelated reason.
  {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 502);
    assert.equal(data.detail, 'upstream status 429');
  }

  // A thrown non-Error (e.g. a raw string, which has no .message) must still
  // produce a useful detail via the `|| err` fallback, not "undefined".
  {
    globalThis.fetch = async () => { throw 'network unreachable'; };
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 502);
    assert.equal(data.detail, 'network unreachable');
  }

  // No years param at all defaults to 3 -- every other test here always
  // passes years explicitly, so the `|| 3` default had never actually run.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(260) } });
    const { status, data } = await analyze(baseEnv(), undefined, await sessionCookieHeader());
    assert.equal(status, 200);
    assert.equal(data.years, 3);
  }

  // A genuine decline must report a negative maxDrawdownPct. Every other bars
  // fixture here rises monotonically, so peak === lastClose always and
  // `dd < maxDd` never fires -- maxDrawdownPct had only ever been pinned at
  // its initial, unset 0.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeDeclineBars(50, 30) } });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 200);
    assert.ok(data.metrics.maxDrawdownPct < 0, 'a real decline must report a negative drawdown, not the unset 0');
  }

  // 90 bars: enough for sma50 (computable, real average) but not sma200
  // (null, not enough history). aboveSma200 must stay null -- if the null
  // guard is dropped, `lastClose > null` coerces to `lastClose > 0` and
  // reports true for every symbol regardless of its actual 200-day average.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(90) } });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 200);
    assert.equal(data.metrics.sma200, null);
    assert.equal(data.metrics.aboveSma200, null);
    assert.equal(typeof data.metrics.sma50, 'number');
    assert.equal(data.metrics.aboveSma50, data.metrics.lastClose > data.metrics.sma50);
  }

  // No Workers AI binding: still 200 with the deterministic metrics, but the
  // narrative degrades to data-only rather than a template-filled fake one.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(260) } });
    const { status, data } = await analyze(baseEnv(), 1, await sessionCookieHeader());
    assert.equal(status, 200);
    assert.equal(data.narrative, null);
    assert.equal(data.dataOnly, true);
  }

  // With an AI binding, the narrative is passed through and dataOnly flips false.
  {
    globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(260) } });
    const env = baseEnv({ AI: { run: async () => ({ response: 'Trend read: steady grind higher.' }) } });
    const { status, data } = await analyze(env, 1, await sessionCookieHeader());
    assert.equal(status, 200);
    assert.equal(data.narrative, 'Trend read: steady grind higher.');
    assert.equal(data.dataOnly, false);
  }
} finally {
  globalThis.fetch = originalFetch;
}

// The 6/min rate-limit guard (scope 'market-analyst') trips before the 7th
// request reaches Alpaca -- mirrors the guard premium-stock-research.js pins
// in tests/premium-stock-research-api.test.mjs, never checked here even
// though this route spends a real AI call per request.
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ bars: { QQQ: makeBars(260) } }); };
  try {
    const ip = '10.9.9.1';
    const cookie = await sessionCookieHeader();
    const req = () => onRequestGet({
      request: new Request('https://example.com/api/premium-market-analyst?years=1', {
        headers: { 'CF-Connecting-IP': ip, ...cookie },
      }),
      env: baseEnv(),
    });
    for (let i = 0; i < 6; i++) await req();
    assert.equal(calls, 6);
    const limited = await req();
    assert.equal(limited.status, 429);
    const limitedData = await limited.json();
    assert.equal(limitedData.ok, false);
    assert.equal(calls, 6, 'the limited request must never reach Alpaca');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Tier entitlement. /api/premium-market-analyst is declared COMPLETE in
// RESOURCE_TIERS, so a Futures Core member is authenticated but not entitled.
// ---------------------------------------------------------------------------

async function tierCookie(tier) {
  const token = await signSession(
    { v: SESSION_VERSION, mr: 'member-1', t: tier, exp: Date.now() + 60000 },
    SIGNING_SECRET,
  );
  return { Cookie: `__Host-vjm_session=${token}` };
}

{
  const noUpstream = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca before authorizing'); };
  try {
    // Under-tier: 403 (upgrade), distinguishable from the 401 an unauthenticated
    // visitor gets, and returned before any upstream call or AI spend.
    const { status, data } = await analyze(baseEnv(), 3, await tierCookie(TIERS.FUTURES_CORE));
    assert.equal(status, 403, 'an under-tier member must get 403, not 401');
    assert.equal(data.code, 'upgrade_required');
    assert.equal(data.requiredTier, TIERS.COMPLETE);
    assert.equal(data.heldTier, TIERS.FUTURES_CORE);
  } finally {
    globalThis.fetch = noUpstream;
  }
}

{
  // A Complete member is served exactly as before.
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ bars: { QQQ: makeBars(260) } });
  try {
    const { status, data } = await analyze(baseEnv(), 1, await tierCookie(TIERS.COMPLETE));
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  } finally {
    globalThis.fetch = previous;
  }
}

console.log('VJM premium-market-analyst API tests passed.');

// ---------------------------------------------------------------------------
// Mid-session revocation on the paid endpoint itself.
//
// A valid HMAC signature only proves the cookie was ours when it was minted.
// This route verified the signature and the signed tier claim but never asked
// whether the membership still existed, so a canceled member kept the paid
// endpoint for the remaining life of the cookie (up to 30 days) -- the exact
// leak migration 0006's session_epoch/status check was added to close, which
// this route was bypassing because it calls verifySessionToken directly
// rather than getSession.
// ---------------------------------------------------------------------------

const REVOKE_MR = 'b'.repeat(16);

async function liveMemberCookie() {
  const token = await signSession(
    { v: SESSION_VERSION, mr: REVOKE_MR, t: TIERS.COMPLETE, sv: 1, src: 'd1', exp: Date.now() + 60000 },
    SIGNING_SECRET,
  );
  return { Cookie: `__Host-vjm_session=${token}` };
}

// A D1 fake serving one whop_codes row for the member_ref lookup.
const rowDb = (row) => ({
  RESEARCH_DB: { prepare() { return { bind() { return { async first() { return row; } }; } }; } },
});

{
  const noUpstream = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call upstream for a revoked member'); };
  try {
    for (const [label, row] of [
      ['revoked', { status: 'revoked', expires_at: null, session_epoch: 1 }],
      ['expired', { status: 'active', expires_at: new Date(Date.now() - 86400000).toISOString(), session_epoch: 1 }],
      ['epoch bumped by a cancellation', { status: 'active', expires_at: null, session_epoch: 2 }],
    ]) {
      const { status } = await analyze(baseEnv(rowDb(row)), 3, await liveMemberCookie());
      assert.equal(status, 401, `a ${label} member must lose this paid endpoint before the cookie expires`);
    }
    // Control: the same cookie against a live row is still served.
    const live = await analyze(
      baseEnv(rowDb({ status: 'active', expires_at: null, session_epoch: 1 })), 3, await liveMemberCookie());
    assert.notEqual(live.status, 401, 'a live member must still be authorized');
  } finally {
    globalThis.fetch = noUpstream;
  }
}
