// Regression coverage for functions/api/_lib/alpaca.js -- the last
// functions/api/_lib/*.js file with zero direct test references. It's
// imported by five handlers (assistant.js, market-brief.js, ticker.js,
// stock-research.js, premium-stock-research.js), but every one of those
// handlers' tests only ever mocks globalThis.fetch at the handler level to
// return a canned snapshot shape -- summarizeSnapshot's own null/NaN guards,
// movers'/computedMovers' fail-soft-to-null catches, and the gainers/losers
// sort-and-slice have never been exercised directly against this file's
// exports.
//
// Writing computedMovers' coverage found a real bug: with the site's actual
// fixed universes (assistant.js's UNIVERSE is 8 symbols, market-brief.js's
// DEFAULT_UNIVERSE is 10), an unconditional rows.slice(0,8)/rows.slice(-8)
// meant that whenever 8 or fewer symbols had valid data, gainers and losers
// came back as the *same* set, just reordered -- a flat day would show every
// symbol as both a "top gainer" and a "top loser". Fixed by filtering on
// sign before slicing; pinned below.
import assert from 'node:assert/strict';
import { alpacaConfigured, snapshots, summarizeSnapshot, movers, computedMovers } from '../functions/api/_lib/alpaca.js';

// ─── alpacaConfigured ───────────────────────────────────────────────────────
{
  assert.equal(alpacaConfigured({}), false, 'no keys at all');
  assert.equal(alpacaConfigured({ ALPACA_API_KEY: 'k' }), false, 'secret missing');
  assert.equal(alpacaConfigured({ ALPACA_SECRET_KEY: 's' }), false, 'key missing');
  assert.equal(alpacaConfigured({ ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }), true);
}

const originalFetch = globalThis.fetch;
const env = { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' };

try {
  // ─── snapshots(): request shape and the top-level (unwrapped) shape ───────
  {
    let seenUrl, seenHeaders;
    globalThis.fetch = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return Response.json({ SPY: { latestTrade: { p: 500 } }, 'BRK.B': { latestTrade: { p: 400 } } });
    };
    const data = await snapshots(env, ['SPY', 'BRK.B']);
    assert.equal(seenUrl, 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=SPY,BRK.B&feed=iex', 'symbols are individually URI-encoded, then comma-joined');
    assert.equal(seenHeaders['APCA-API-KEY-ID'], 'k');
    assert.equal(seenHeaders['APCA-API-SECRET-KEY'], 's');
    assert.deepEqual(data.SPY, { latestTrade: { p: 500 } }, 'response body read at the top level, not under a "snapshots" wrapper');
  }

  // A falsy JSON body (e.g. `null`) must not propagate as null -- callers
  // index into this map directly.
  {
    globalThis.fetch = async () => Response.json(null);
    const data = await snapshots(env, ['SPY']);
    assert.deepEqual(data, {});
  }

  // A non-ok upstream status throws, same as any other Alpaca failure.
  {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });
    await assert.rejects(() => snapshots(env, ['SPY']));
  }
} finally {
  globalThis.fetch = originalFetch;
}

// ─── summarizeSnapshot ──────────────────────────────────────────────────────
{
  assert.equal(summarizeSnapshot('SPY', null), null, 'no snapshot at all');
  assert.equal(summarizeSnapshot('SPY', undefined), null);
  assert.equal(summarizeSnapshot('SPY', {}), null, 'no latestTrade -> no usable price, never fabricated');
  assert.equal(summarizeSnapshot('SPY', { latestTrade: { p: 'not-a-number' } }), null, 'non-numeric price must not be coerced');

  const full = summarizeSnapshot('SPY', {
    latestTrade: { p: 501.005, t: '2026-01-01T00:00:00Z' },
    prevDailyBar: { c: 500, v: 1000 },
    dailyBar: { v: 2000 },
  });
  assert.equal(full.price, 501, 'price rounded to 2 decimals');
  assert.equal(full.prevClose, 500);
  assert.equal(full.changePct, 0.2, '(501.005 - 500) / 500 * 100, rounded');
  assert.equal(full.dayVolume, 2000, 'dailyBar volume preferred over prevDailyBar');
  assert.equal(full.asOf, '2026-01-01T00:00:00Z');
  assert.equal(full.feed, 'iex');

  // dailyBar absent -> falls back to prevDailyBar for volume.
  const fallbackBar = summarizeSnapshot('SPY', { latestTrade: { p: 100 }, prevDailyBar: { c: 90, v: 55 } });
  assert.equal(fallbackBar.dayVolume, 55);

  // No prevDailyBar at all -> prevClose and changePct stay null, not 0 or NaN.
  const noPrev = summarizeSnapshot('SPY', { latestTrade: { p: 100 } });
  assert.equal(noPrev.prevClose, null);
  assert.equal(noPrev.changePct, null);

  // A prevClose of exactly 0 (e.g. a fresh listing) would divide by zero --
  // must degrade to null rather than fabricate Infinity/NaN.
  const zeroPrev = summarizeSnapshot('SPY', { latestTrade: { p: 5 }, prevDailyBar: { c: 0 } });
  assert.equal(zeroPrev.prevClose, 0);
  assert.equal(zeroPrev.changePct, null, 'division by a zero prevClose must not fabricate a change percentage');
}

// ─── movers(): official screener, fails soft to null ───────────────────────
try {
  globalThis.fetch = async () => Response.json({
    gainers: Array.from({ length: 10 }, (_, i) => ({ symbol: `G${i}`, price_change_percent: i, price: 10 + i })),
    losers: Array.from({ length: 10 }, (_, i) => ({ symbol: `L${i}`, price_change_percent: -i, price: 10 - i })),
  });
  const result = await movers(env);
  assert.equal(result.gainers.length, 8, 'capped at 8');
  assert.equal(result.losers.length, 8);
  assert.equal(result.source, 'Alpaca market screener');
  assert.equal(result.gainers[0].symbol, 'G0');

  globalThis.fetch = async () => { throw new Error('screener down'); };
  assert.equal(await movers(env), null, 'a thrown upstream error must degrade to null, never propagate');

  globalThis.fetch = async () => new Response('nope', { status: 500 });
  assert.equal(await movers(env), null, 'a non-ok status must also degrade to null');
} finally {
  globalThis.fetch = originalFetch;
}

// ─── computedMovers(): sort, filter by sign, and label as computed ─────────
try {
  const universe = ['A', 'B', 'C', 'D', 'E'];
  const snaps = {
    A: { latestTrade: { p: 110 }, prevDailyBar: { c: 100 } }, // +10%
    B: { latestTrade: { p: 90 }, prevDailyBar: { c: 100 } },  // -10%
    C: { latestTrade: { p: 105 }, prevDailyBar: { c: 100 } }, // +5%
    D: {}, // no usable price -- must be filtered out, not crash the sort
    E: { latestTrade: { p: 100 }, prevDailyBar: { c: 100 } }, // 0%
  };
  globalThis.fetch = async () => Response.json(snaps);

  const result = await computedMovers(env, universe);
  assert.equal(result.source, 'computed from 5-symbol IEX snapshot universe');
  assert.deepEqual(result.gainers.map((r) => r.symbol), ['A', 'C'], 'D dropped (no price), E dropped (0% is not a gain)');
  assert.deepEqual(result.losers.map((r) => r.symbol), ['B'], 'worst loser first; E is not a loss');

  // The overlap regression: a small, all-populated universe (matching
  // assistant.js's real 8-symbol UNIVERSE) must not put the same symbols in
  // both panels just because there are 8 or fewer of them.
  {
    const eightUniverse = ['P1', 'P2', 'P3', 'P4', 'N1', 'N2', 'N3', 'N4'];
    const pct = { P1: 8, P2: 6, P3: 4, P4: 2, N1: -1, N2: -3, N3: -5, N4: -7 };
    globalThis.fetch = async () => Response.json(
      Object.fromEntries(eightUniverse.map((s) => [s, { latestTrade: { p: 100 + pct[s] }, prevDailyBar: { c: 100 } }])),
    );
    const eightResult = await computedMovers(env, eightUniverse);
    assert.deepEqual(eightResult.gainers.map((r) => r.symbol), ['P1', 'P2', 'P3', 'P4']);
    assert.deepEqual(eightResult.losers.map((r) => r.symbol), ['N4', 'N3', 'N2', 'N1'], 'worst (most negative) first');
    const overlap = eightResult.gainers.map((r) => r.symbol).filter((s) => eightResult.losers.some((l) => l.symbol === s));
    assert.deepEqual(overlap, [], 'gainers and losers must never share a symbol');
  }

  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await computedMovers(env, universe), null, 'a thrown error must degrade to null, never propagate');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM alpaca lib tests passed.');
