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

console.log('VJM research API route tests passed.');
