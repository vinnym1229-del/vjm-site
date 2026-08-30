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

console.log('VJM premium-market-analyst API tests passed.');
