// Regression coverage for /api/stock-research (functions/api/stock-research.js).
//
// This is one of the two probe-targeted endpoints (the run cycle's own
// live-deployment check hits it by curl) with zero test references. Its own
// comment documents a real fixed bug that nothing pinned: Alpaca's
// /v2/stocks/snapshots response puts the symbol->snapshot map at the TOP
// LEVEL, not wrapped in a "snapshots" key -- that shape was already wrong
// once in _lib/alpaca.js, so the handler accepts either shape defensively.
// Also pins: missing-config fails closed (503) before any upstream call,
// changePercent math, and marketCap staying null rather than fabricated
// (the code's own comment: "showing a stale number would be fabrication").
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/stock-research.js';

function baseEnv() {
  return { ALPACA_API_KEY: 'key', ALPACA_SECRET_KEY: 'secret' };
}

let ipCounter = 0;
async function lookup(env, symbol) {
  ipCounter += 1;
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/stock-research?symbol=${encodeURIComponent(symbol)}`, {
      headers: { 'CF-Connecting-IP': `10.2.0.${ipCounter}` },
    }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// Missing/invalid symbol rejected before any config or upstream check.
{
  const { status, data } = await lookup(baseEnv(), '');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
}

// No Alpaca keys configured: fails closed, never attempts the upstream call.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca without keys configured'); };
  try {
    const { status, data } = await lookup({}, 'AAPL');
    assert.equal(status, 503);
    assert.equal(data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The 30/min rate-limit guard (keyed by scope+ip+symbol, since this route
// costs a real Alpaca call) trips before the 31st request for the same
// symbol from the same IP reaches fetch at all.
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ AAPL: {} }); };
  try {
    const ip = '10.7.0.1';
    const req = () => onRequestGet({
      request: new Request('https://example.com/api/stock-research?symbol=AAPL', {
        headers: { 'CF-Connecting-IP': ip },
      }),
      env: baseEnv(),
    });
    for (let i = 0; i < 30; i++) await req();
    assert.equal(calls, 30);
    const limited = await req();
    assert.equal(limited.status, 429);
    const limitedData = await limited.json();
    assert.equal(limitedData.ok, false);
    assert.equal(calls, 30, 'the limited request must never reach Alpaca');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalFetch = globalThis.fetch;
try {
  // Top-level shape (symbol -> snapshot directly, no "snapshots" wrapper) --
  // this is the actual shape Alpaca returns today.
  {
    globalThis.fetch = async () => Response.json({
      AAPL: {
        latestTrade: { p: 150.5, t: '2026-08-30T12:00:00Z' },
        dailyBar: { c: 150.5, v: 1000000, vw: 149.9 },
        prevDailyBar: { c: 148, v: 900000 },
      },
    });
    const { status, data } = await lookup(baseEnv(), 'AAPL');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.quote.price, 150.5);
    assert.equal(data.quote.prevClose, 148);
    assert.ok(Math.abs(data.quote.change - 2.5) < 1e-9);
    assert.ok(Math.abs(data.quote.changePercent - (2.5 / 148) * 100) < 1e-9);
    assert.equal(data.quote.marketCap, null, 'marketCap must stay null -- no shares-outstanding source, would be fabrication');
  }

  // Wrapped shape (data.snapshots.SYMBOL) must be accepted too, in case
  // Alpaca reverts to it -- the handler must not silently empty out either way.
  {
    globalThis.fetch = async () => Response.json({
      snapshots: {
        AAPL: {
          latestTrade: { p: 151, t: '2026-08-30T12:05:00Z' },
          dailyBar: { c: 151, v: 500000 },
          prevDailyBar: { c: 148, v: 900000 },
        },
      },
    });
    const { status, data } = await lookup(baseEnv(), 'AAPL');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.quote.price, 151);
  }

  // Symbol absent from the snapshot map (e.g. delisted/invalid ticker upstream):
  // must fail as an unavailable quote, not throw or return a fabricated price.
  {
    globalThis.fetch = async () => Response.json({ MSFT: { latestTrade: { p: 400 } } });
    const { status, data } = await lookup(baseEnv(), 'AAPL');
    assert.equal(status, 502);
    assert.equal(data.ok, false);
  }

  // Upstream HTTP error surfaces as the generic unavailable message, not a leak.
  {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });
    const { status, data } = await lookup(baseEnv(), 'AAPL');
    assert.equal(status, 502);
    assert.equal(data.error, 'Quote is temporarily unavailable.');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM stock-research API tests passed.');
