import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/research-engine.js';
import { signSession } from '../functions/api/_lib/session.js';
import { TIERS, SESSION_VERSION } from '../functions/api/_lib/entitlements.js';

async function body(response) {
  return response.json();
}

const health = await onRequestGet({
  request: new Request('https://example.com/api/research-engine?module=health'),
  env: {},
});
assert.equal(health.status, 200);
const healthData = await body(health);
assert.equal(healthData.ok, true);
assert.equal(healthData.configured.alpaca, false);
assert.equal(JSON.stringify(healthData).includes('ALPACA_SECRET_KEY'), false, 'health must not expose secret names or values');

const unauthorized = await onRequestGet({
  request: new Request('https://example.com/api/research-engine?module=options'),
  env: { ALPACA_API_KEY: 'test', ALPACA_SECRET_KEY: 'test' },
});
assert.equal(unauthorized.status, 401);

const originalFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requested.push(url);
  if (url.pathname === '/v2/stocks/QQQ/snapshot') {
    return Response.json({ latestTrade: { p: 600 } });
  }
  if (url.pathname === '/v2/options/contracts') {
    return Response.json({ option_contracts: [
      { symbol: 'QQQ260828C00600000', type: 'call', strike_price: '600', open_interest: '1000' },
      { symbol: 'QQQ260828P00600000', type: 'put', strike_price: '600', open_interest: '800' },
    ] });
  }
  if (url.pathname === '/v1beta1/options/snapshots/QQQ') {
    return Response.json({ snapshots: {
      QQQ260828C00600000: { greeks: { gamma: 0.02 } },
      QQQ260828P00600000: { greeks: { gamma: 0.02 } },
    } });
  }
  if (url.pathname === '/v2/stocks/bars') {
    return Response.json({ bars: { QQQ: [], SPY: [] } });
  }
  return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
};

try {
  const options = await onRequestGet({
    request: new Request('https://example.com/api/research-engine?module=options&symbol=QQQ&expiryDays=7', {
      headers: { 'X-Research-Cron': 'cron-test-secret' },
    }),
    env: {
      ALPACA_API_KEY: 'test-key',
      ALPACA_SECRET_KEY: 'test-secret',
      RESEARCH_CRON_SECRET: 'cron-test-secret',
    },
  });
  assert.equal(options.status, 200);
  const optionsData = await body(options);
  assert.equal(optionsData.ok, true);
  assert.equal(optionsData.data.contractsAnalyzed, 2);
  assert.ok(optionsData.data.netGexMm > 0, 'call OI exceeds put OI in the modeled test fixture');
  assert.ok(requested.some((url) => url.searchParams.get('feed') === 'indicative'), 'free options requests must explicitly select the indicative feed');
  assert.ok(requested.every((url) => !url.toString().includes('test-secret')), 'API secrets must stay in headers rather than URLs');

  const intraday = await onRequestGet({
    request: new Request('https://example.com/api/research-engine?module=intraday&symbol=QQQ&days=20', {
      headers: { 'X-Research-Cron': 'cron-test-secret' },
    }),
    env: {
      ALPACA_API_KEY: 'test-key',
      ALPACA_SECRET_KEY: 'test-secret',
      RESEARCH_CRON_SECRET: 'cron-test-secret',
    },
  });
  assert.equal(intraday.status, 200);
  const intradayData = await body(intraday);
  assert.equal(intradayData.ok, true);
  assert.ok(requested.some((url) => url.pathname === '/v2/stocks/bars' && url.searchParams.get('feed') === 'sip'), 'futures-style proxy must request consolidated SIP history');
  assert.ok(requested.some((url) => url.pathname === '/v2/stocks/bars' && url.searchParams.get('feed') === 'boats'), 'futures-style proxy must request BOATS overnight history');
  assert.equal(intradayData.source.proxy, 'QQQ/SPY—not NQ/ES');

  // Provenance: a paid study result has to carry enough for the UI to say what
  // the numbers are. They are hypothetical and gross -- no fill model, no
  // costs -- and they are computed under one stated, versioned timing
  // convention. Without this the page can imply live-tradable performance.
  assert.equal(intradayData.provenance.results, 'hypothetical-gross');
  assert.ok(intradayData.provenance.study, 'the result names the study that produced it');
  assert.ok(intradayData.provenance.timingConvention.version, 'the timing convention travels with the result, versioned');
  for (const key of ['observable', 'actionable', 'fill', 'outcome']) {
    assert.ok(intradayData.provenance.timingConvention[key], `provenance must state when a signal is ${key}`);
  }
  assert.match(intradayData.provenance.disclaimer, /hypothetical/i);
  assert.match(intradayData.provenance.disclaimer, /not achieved or live-tradable/i);
  assert.match(intradayData.provenance.timingConvention.costs, /slippage/i, 'the absence of a cost model must be stated, not implied');
  assert.ok(intradayData.provenance.asOf, 'provenance carries its own as-of stamp');
} finally {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Member session authorization.
//
// The Research Engine UI authenticates with the HttpOnly session cookie and
// sends no Authorization header, so before this route read the cookie the page
// could report itself "unlocked" while every data request 401'd. These pin the
// cookie path, the tier split on it, and the fact that the pre-existing cron
// and legacy-Bearer credentials still work alongside it.
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'r'.repeat(32);

function engineEnv(extra = {}) {
  return {
    SESSION_SIGNING_SECRET: SIGNING_SECRET,
    ALPACA_API_KEY: 'test-key',
    ALPACA_SECRET_KEY: 'test-secret',
    ...extra,
  };
}

async function cookieFor(tier) {
  const token = await signSession(
    { v: SESSION_VERSION, mr: 'member-1', t: tier, exp: Date.now() + 60000 },
    SIGNING_SECRET,
  );
  return { Cookie: `__Host-vjm_session=${token}` };
}

// research-engine.js signs and verifies legacy tokens with its OWN
// base64url helper: btoa(unescape(encodeURIComponent(binaryString))). That is
// not binary-safe (bytes above 0x7F round-trip through UTF-8 first), so a
// standard base64 of the same HMAC does NOT match. Signer and verifier share
// the quirk, which is why live legacy tokens still verify — mirror it exactly
// here rather than "fixing" it, or these tests would pin a token shape the
// handler never issued.
function researchB64Url(binaryString) {
  return btoa(unescape(encodeURIComponent(binaryString)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function legacyBearer(payload, secret) {
  const body = researchB64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + researchB64Url(String.fromCharCode(...new Uint8Array(sig)));
}

let engineIp = 0;
async function callEngine(env, query, headers = {}) {
  engineIp += 1;
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/research-engine?${query}`, {
      headers: { 'CF-Connecting-IP': `10.7.0.${engineIp}`, ...headers },
    }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// A Complete member's cookie authorizes the data modules — the end-to-end path
// the browser actually uses. Fixture fetch is the same one used above.
{
  const engineFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/stocks/QQQ/snapshot') return Response.json({ latestTrade: { p: 600 } });
    if (url.pathname === '/v2/options/contracts') {
      return Response.json({ option_contracts: [
        { symbol: 'QQQ260828C00600000', type: 'call', strike_price: '600', open_interest: '1000' },
        { symbol: 'QQQ260828P00600000', type: 'put', strike_price: '600', open_interest: '800' },
      ] });
    }
    if (url.pathname === '/v1beta1/options/snapshots/QQQ') {
      return Response.json({ snapshots: {
        QQQ260828C00600000: { greeks: { gamma: 0.02 } },
        QQQ260828P00600000: { greeks: { gamma: 0.02 } },
      } });
    }
    if (url.pathname === '/v2/stocks/bars') return Response.json({ bars: { QQQ: [], SPY: [] } });
    return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
  };
  try {
    const { status, data } = await callEngine(
      engineEnv(), 'module=options&symbol=QQQ&expiryDays=7', await cookieFor(TIERS.COMPLETE),
    );
    assert.equal(status, 200, 'a Complete member session cookie must reach the data modules');
    assert.equal(data.ok, true);
  } finally {
    globalThis.fetch = engineFetch;
  }
}

// Everything below must be rejected before a single upstream call: an
// authorization regression that leaked one Alpaca request would still burn the
// owner's quota and could return paid data.
const noUpstream = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('must not call Alpaca before authorizing'); };
try {
  // A $100 Futures Core member is authenticated but not entitled: 403, and it
  // must be distinguishable from 401 so the UI can say "your plan does not
  // include this" instead of asking them to sign in again.
  {
    const { status, data } = await callEngine(
      engineEnv(), 'module=options', await cookieFor(TIERS.FUTURES_CORE),
    );
    assert.equal(status, 403, 'an under-tier member must get 403, not 401');
    assert.equal(data.code, 'upgrade_required');
    assert.equal(data.requiredTier, TIERS.COMPLETE);
    assert.equal(data.heldTier, TIERS.FUTURES_CORE);
  }

  // No cookie at all: 401 (sign in), never 403.
  {
    const { status, data } = await callEngine(engineEnv(), 'module=options');
    assert.equal(status, 401);
    assert.equal(data.code, undefined, 'an unauthenticated caller is not an upgrade prompt');
  }

  // Tampered cookie (payload swapped to claim Complete, signature untouched)
  // fails closed as unauthenticated — a forged tier claim is not a tier.
  {
    const forged = btoa(JSON.stringify({ v: SESSION_VERSION, t: TIERS.COMPLETE, exp: Date.now() + 60000 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const { status } = await callEngine(engineEnv(), 'module=options', {
      Cookie: `__Host-vjm_session=${forged}.notavalidsignature`,
    });
    assert.equal(status, 401, 'an unsigned/forged cookie must not authorize');
  }

  // Fail closed on missing config: with no signing secret configured, a
  // perfectly well-formed cookie cannot be verified and must not be trusted.
  {
    const headers = await cookieFor(TIERS.COMPLETE);
    const { status } = await callEngine(
      { ALPACA_API_KEY: 'test-key', ALPACA_SECRET_KEY: 'test-secret' }, 'module=options', headers,
    );
    assert.equal(status, 401);
  }

  // An under-tier session cannot be upgraded by also presenting a valid legacy
  // Bearer token — otherwise the migration path would be a tier bypass.
  {
    const legacy = await legacyBearer({ exp: Date.now() + 60000 }, 'legacy-codes');
    const headers = await cookieFor(TIERS.FUTURES_CORE);
    const { status } = await callEngine(
      engineEnv({ PREMIUM_ACCESS_CODES: 'legacy-codes' }), 'module=options',
      { ...headers, Authorization: `Bearer ${legacy}` },
    );
    assert.equal(status, 403, 'a legacy Bearer token must not override a verified session tier');
  }

  // The legacy Bearer path still authorizes on its own (no cookie present):
  // the migration window the handler documents is still open. It gets past
  // authorization and fails only on the stubbed upstream, proving auth passed.
  {
    const legacy = await legacyBearer({ exp: Date.now() + 60000 }, 'legacy-codes');
    const { status } = await callEngine(
      engineEnv({ PREMIUM_ACCESS_CODES: 'legacy-codes' }), 'module=options',
      { Authorization: `Bearer ${legacy}` },
    );
    assert.equal(status, 502, 'legacy Bearer must still pass authorization (failing later, upstream)');
  }

  // An expired legacy Bearer token is still rejected.
  {
    const token = await legacyBearer({ exp: Date.now() - 1000 }, 'legacy-codes');
    const { status } = await callEngine(
      engineEnv({ PREMIUM_ACCESS_CODES: 'legacy-codes' }), 'module=options',
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(status, 401);
  }

  // The scheduled refresh job still authorizes with its shared secret and no
  // cookie — it has no browser and cannot hold one.
  {
    const { status } = await callEngine(
      engineEnv({ RESEARCH_CRON_SECRET: 'cron-test-secret' }), 'module=options',
      { 'X-Research-Cron': 'cron-test-secret' },
    );
    assert.equal(status, 502, 'the cron header must still pass authorization (failing later, upstream)');
  }

  // A wrong cron secret is not a credential.
  {
    const { status } = await callEngine(
      engineEnv({ RESEARCH_CRON_SECRET: 'cron-test-secret' }), 'module=options',
      { 'X-Research-Cron': 'cron-wrong-secret!' },
    );
    assert.equal(status, 401);
  }
} finally {
  globalThis.fetch = noUpstream;
}

// Health stays public: it is the page's own configuration probe and exposes
// booleans only, so gating it would break the gate itself.
{
  const { status, data } = await callEngine({}, 'module=health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
}

// ---------------------------------------------------------------------------
// module=stock, module=sectors, module=biotech, the unknown-module 400, the
// missing-Alpaca-config 503, and the D1 cached-snapshot fallback on a live
// refresh failure. Every one of these was reachable only through 'options'
// and 'intraday' before this file's own fetch fixtures existed, so the other
// three data modules -- and the two error paths every module shares -- had
// never been exercised at the handler level, only indirectly through their
// pure helpers in tests/research-engine.test.mjs.
// ---------------------------------------------------------------------------

function dailyBar(dateIso, o, h, l, c, v = 1_000_000) {
  return { t: dateIso, o, h, l, c, v };
}

// A daily series with a linear drift plus a slow oscillation, long enough to
// print real swing highs for stockModule's fib study (needs pivot*2+25 = 35
// bars at the default pivot) and enough weeks for the weekly leg too.
function makeDailySeries(n, { start = 90, drift = 0.15 } = {}) {
  const bars = [];
  let date = new Date('2026-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const close = start + i * drift + Math.sin(i / 4) * 6;
    const open = i === 0 ? close - 1 : bars[i - 1].c;
    const high = Math.max(open, close) + 1.5;
    const low = Math.min(open, close) - 1.5;
    bars.push(dailyBar(date.toISOString(), open, high, low, close, 1_000_000 + (i % 7) * 25_000));
    date = new Date(date.getTime() + 86400000);
  }
  return bars;
}

{
  const cronEnv = { ALPACA_API_KEY: 'test-key', ALPACA_SECRET_KEY: 'test-secret', RESEARCH_CRON_SECRET: 'cron-test-secret' };
  const cronHeaders = { 'X-Research-Cron': 'cron-test-secret' };

  // module=stock: the fib retracement study, never reached by any prior test.
  {
    const stockFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/stocks/bars') return Response.json({ bars: { NVDA: makeDailySeries(150) } });
      return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
    };
    try {
      const { status, data } = await callEngine(cronEnv, 'module=stock&symbol=NVDA', cronHeaders);
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.data.summary.lastPrice, makeDailySeries(150).at(-1).c);
      assert.deepEqual(data.data.fibStats.map((s) => s.level), [.382, .5, .618], 'all three fib levels always report, even with zero touches');
      assert.equal(data.data.timeframeBreakdown.length, 2, 'the default timeframe=combined runs both a Daily and a Weekly leg');
      assert.deepEqual(data.data.timeframeBreakdown.map((t) => t.timeframe), ['Daily', 'Weekly']);
    } finally {
      globalThis.fetch = stockFetch;
    }
  }

  // module=stock: too few adjusted daily bars must fail 422, not compute a
  // study off a handful of days -- and with no RESEARCH_DB, the outer catch's
  // cache-fallback finds nothing and the 422 reaches the caller.
  {
    const stockFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/stocks/bars') return Response.json({ bars: { NVDA: makeDailySeries(10) } });
      return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
    };
    try {
      const { status, data } = await callEngine(cronEnv, 'module=stock&symbol=NVDA', cronHeaders);
      assert.equal(status, 422);
      assert.equal(data.ok, false);
    } finally {
      globalThis.fetch = stockFetch;
    }
  }

  // module=sectors: relative strength must actually rank the outperformer
  // first and the underperformer last, not just return unsorted rows.
  {
    const sectorFetch = globalThis.fetch;
    const SECTOR_ETFS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/stocks/bars') {
        const symbols = url.searchParams.get('symbols').split(',');
        const bars = Object.fromEntries(symbols.map((s) => [
          s,
          makeDailySeries(30, { drift: s === 'XLK' ? 1.5 : s === 'XLU' ? -1.5 : 0.1 }),
        ]));
        return Response.json({ bars });
      }
      return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
    };
    try {
      const { status, data } = await callEngine(cronEnv, 'module=sectors', cronHeaders);
      assert.equal(status, 200);
      assert.equal(data.data.benchmark, 'QQQ');
      assert.equal(data.data.rows.length, SECTOR_ETFS.length);
      assert.equal(data.data.rows[0].etf, 'XLK', 'the strongest sector must sort first');
      assert.equal(data.data.rows.at(-1).etf, 'XLU', 'the weakest sector must sort last');
    } finally {
      globalThis.fetch = sectorFetch;
    }
  }

  // module=biotech: no relative-strength sort, but the fixed universe and its
  // "not connected" catalyst fields are the contract the UI reads.
  {
    const bioFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/stocks/bars') {
        const symbols = url.searchParams.get('symbols').split(',');
        const bars = Object.fromEntries(symbols.map((s) => [s, makeDailySeries(30)]));
        return Response.json({ bars });
      }
      return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
    };
    try {
      const { status, data } = await callEngine(cronEnv, 'module=biotech', cronHeaders);
      assert.equal(status, 200);
      assert.equal(data.data.rows.length, 10);
      assert.ok(data.data.rows.every((r) => ['HIGH', 'REVIEW', 'LOW'].includes(r.riskFlag)));
      assert.ok(data.data.rows.every((r) => r.catalyst === null && r.catalystStatus === 'Not available from Alpaca'));
      assert.equal(data.data.missingFields.length, 6);
    } finally {
      globalThis.fetch = bioFetch;
    }
  }

  // An unrecognized module must 400 before touching Alpaca at all -- proven
  // by a fetch mock that throws if it's ever called.
  {
    const noCallFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('must not call Alpaca for an unknown module'); };
    try {
      const { status, data } = await callEngine(cronEnv, 'module=nope', cronHeaders);
      assert.equal(status, 400);
      assert.equal(data.ok, false);
    } finally {
      globalThis.fetch = noCallFetch;
    }
  }

  // Alpaca not configured on the server: fail closed 503 after authorization
  // but before any module runs, for a credential that would otherwise pass.
  {
    const { status, data } = await callEngine({ RESEARCH_CRON_SECRET: 'cron-test-secret' }, 'module=options', cronHeaders);
    assert.equal(status, 503);
    assert.equal(data.ok, false);
  }
}

// D1 cached-snapshot fallback: a live refresh failure must serve the last
// saved snapshot for the same module+params, marked stale, rather than a
// hard error -- the Research Engine's own comment documents this as
// intentional degrade-on-outage behavior, but nothing had exercised the D1
// write/read round trip that makes it work (research_snapshots + the
// research_latest upsert saveSnapshot performs, and the SELECT loadLatest
// reads back). Minimal fake mirrors the same two tables market-brief.js's
// test fixture uses for the shared research_latest cache.
function makeResearchDb() {
  const latest = new Map();
  function apply(sql, args) {
    if (sql.includes('INSERT INTO research_latest')) {
      const [cacheKey, , , payload] = args;
      latest.set(cacheKey, payload);
    }
  }
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            async run() { apply(sql, args); return { meta: { changes: 1 } }; },
            async first() {
              if (sql.includes('SELECT payload FROM research_latest')) {
                const [cacheKey] = args;
                return latest.has(cacheKey) ? { payload: latest.get(cacheKey) } : null;
              }
              return null;
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const stmt of statements) apply(stmt.sql, stmt.args);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

{
  const db = makeResearchDb();
  const dbEnv = { ALPACA_API_KEY: 'test-key', ALPACA_SECRET_KEY: 'test-secret', RESEARCH_CRON_SECRET: 'cron-test-secret', RESEARCH_DB: db };
  const cronHeaders = { 'X-Research-Cron': 'cron-test-secret' };
  const query = 'module=options&symbol=QQQ&expiryDays=7';

  const liveFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/stocks/QQQ/snapshot') return Response.json({ latestTrade: { p: 600 } });
    if (url.pathname === '/v2/options/contracts') return Response.json({ option_contracts: [] });
    if (url.pathname === '/v1beta1/options/snapshots/QQQ') return Response.json({ snapshots: {} });
    return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
  };
  let firstSpot;
  try {
    const { status, data } = await callEngine(dbEnv, query, cronHeaders);
    assert.equal(status, 200);
    firstSpot = data.data.spot;
    assert.equal(firstSpot, 600, 'the live snapshot saved to D1 must be the one served back on a later outage');
  } finally {
    globalThis.fetch = liveFetch;
  }

  globalThis.fetch = async () => { throw new Error('simulated Alpaca outage'); };
  try {
    const { status, data } = await callEngine(dbEnv, query, cronHeaders);
    assert.equal(status, 200, 'a cached snapshot must still serve 200, not surface the outage as an error');
    assert.equal(data.ok, true);
    assert.equal(data.cached, true);
    assert.equal(data.data.spot, firstSpot, 'the served snapshot must be the exact one saved, not a fresh (failed) computation');
    assert.match(data.warning, /Live refresh failed/);
  } finally {
    globalThis.fetch = liveFetch;
  }
}

console.log('VJM research API route tests passed.');
