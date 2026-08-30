// Regression coverage for /api/ticker (functions/api/ticker.js).
//
// This was the last of the two probe-targeted endpoints (the run cycle's own
// live-deployment check hits /api/ticker by curl) with zero test references
// -- content.js, the other one, already has tests/content-api.test.mjs. Pins:
// the rate-limit guard trips before any Alpaca call (this route costs money),
// an unconfigured deployment answers 200 { pending:true } instead of an
// error so it doesn't spam the console on every visit, a successful pull
// merges the equity snapshots with the separate BTC lookup into one list,
// a failed/empty BTC lookup degrades gracefully (equities alone still ship
// if there are enough of them), and too few usable snapshots overall (< 4)
// is treated as a failure rather than shipping a half-empty tape.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/ticker.js';

function configuredEnv() {
  return { ALPACA_API_KEY: 'key', ALPACA_SECRET_KEY: 'secret' };
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.3.0.${ipCounter}`;
}

async function call(env, ip) {
  const res = await onRequestGet({
    request: new Request('https://example.com/api/ticker', {
      headers: { 'CF-Connecting-IP': ip },
    }),
    env,
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

function equitySnapshot(price, prevClose) {
  return {
    latestTrade: { p: price, t: '2026-08-30T14:00:00Z' },
    dailyBar: { c: price, v: 1000000 },
    prevDailyBar: { c: prevClose, v: 900000 },
  };
}

// All ten EQUITIES symbols, in case a test needs a full valid snapshot map.
const ALL_SYMBOLS = ['QQQ', 'SPY', 'DIA', 'IWM', 'GLD', 'USO', 'AAPL', 'TSLA', 'NVDA', 'MSFT'];

function fullEquitySnapshots() {
  const out = {};
  for (const sym of ALL_SYMBOLS) out[sym] = equitySnapshot(100, 98);
  return out;
}

const btcSnapshot = {
  snapshots: {
    'BTC/USD': {
      latestTrade: { p: 65000.4, t: '2026-08-30T14:00:00Z' },
      prevDailyBar: { c: 64000 },
    },
  },
};

// Rate limit trips before the Alpaca-configured check, since the guard
// exists to cap third-party call volume, not to gate on config. An
// unconfigured env proves this cleanly: it never reaches fetch either way,
// so a leaked call would throw and fail the test loudly.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca while rate-limit gating the request'); };
  try {
    const ip = nextIp();
    let last;
    for (let i = 0; i < 60; i++) last = await call({}, ip);
    assert.equal(last.status, 200);
    assert.equal(last.data.pending, true);

    const limited = await call({}, ip);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Not configured: 200 with pending:true, not an error status -- an
// unconfigured deployment shouldn't spam the console on every page load.
{
  const { status, data } = await call({}, nextIp());
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.pending, true);
}

const originalFetch = globalThis.fetch;
try {
  // Successful pull: equities snapshot merges with the separate BTC lookup
  // into a single items list, and the response carries the shared-edge-cache
  // header the run cycle depends on to absorb polling.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('crypto')) return Response.json(btcSnapshot);
      return Response.json(fullEquitySnapshots());
    };
    const { status, headers, data } = await call(configuredEnv(), nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.feed, 'iex');
    assert.equal(data.items.length, ALL_SYMBOLS.length + 1, 'ten equities plus BTC');
    const btcItem = data.items.find((it) => it.symbol === 'BTCUSD');
    assert.ok(btcItem, 'BTC item missing from merged tape');
    assert.equal(btcItem.asset, 'crypto');
    const spyItem = data.items.find((it) => it.symbol === 'SPY');
    assert.equal(spyItem.asset, 'equity');
    assert.equal(spyItem.label, 'ES · SPY');
    assert.match(headers.get('Cache-Control') || '', /max-age=10/);
  }

  // BTC lookup fails (upstream non-200): degrades gracefully rather than
  // failing the whole tape, as long as enough equities came back.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('crypto')) return new Response('down', { status: 500 });
      return Response.json(fullEquitySnapshots());
    };
    const { status, data } = await call(configuredEnv(), nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.items.length, ALL_SYMBOLS.length, 'BTC dropped, equities still ship');
    assert.ok(!data.items.some((it) => it.asset === 'crypto'));
  }

  // Too few usable snapshots (< 4) overall: treated as a failure, not a
  // half-empty tape -- and the caught error stays generic, no upstream
  // detail leaked into the public payload.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('crypto')) return new Response('down', { status: 500 });
      return Response.json({});
    };
    const { status, data } = await call(configuredEnv(), nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'Ticker data unavailable.');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM ticker API tests passed.');
