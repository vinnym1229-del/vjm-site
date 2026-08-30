// Regression coverage for /api/premium-stock-research (functions/api/premium-stock-research.js).
//
// This was the last payment-gated functions/api/*.js file with zero test
// references. Unlike the free /api/stock-research, this route is authorized
// server-side via TWO paths: the HttpOnly session cookie (primary) or a
// legacy HMAC Bearer token kept only for research-engine's migration window
// (see the handler's own comment). Neither path had ever been pinned, so an
// authorization regression here -- e.g. an expired or forged legacy token
// being accepted -- would leak paid quotes to anyone. Also pins the same
// Alpaca top-level-vs-wrapped snapshot shape fallback already fixed once in
// _lib/alpaca.js and stock-research.js, and the marketCap fabrication guard.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/premium-stock-research.js';
import { signSession, base64UrlEncodeBytes } from '../functions/api/_lib/session.js';

const SIGNING_SECRET = 'x'.repeat(32);
const LEGACY_CODES = 'legacy-codes-secret';

function baseEnv(extra = {}) {
  return { SESSION_SIGNING_SECRET: SIGNING_SECRET, ALPACA_API_KEY: 'key', ALPACA_SECRET_KEY: 'secret', ...extra };
}

// Builds a legacy Bearer token exactly the way premium-stock-research.js's
// own isAuthorized() verifies it: base64url(JSON payload) + '.' +
// base64url(HMAC-SHA256(payload, secret)).
async function signLegacyToken(payload, secret) {
  const body = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sigB64 = base64UrlEncodeBytes(new Uint8Array(sig));
  return `${body}.${sigB64}`;
}

let ipCounter = 0;
async function lookup(env, symbol, headers = {}) {
  ipCounter += 1;
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/premium-stock-research?symbol=${encodeURIComponent(symbol)}`, {
      headers: { 'CF-Connecting-IP': `10.3.0.${ipCounter}`, ...headers },
    }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// Missing/invalid symbol rejected before any auth or config check.
{
  const { status, data } = await lookup(baseEnv(), '');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
}

// No session cookie, no Bearer token: rejected before any upstream call.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca without authorization'); };
  try {
    const { status, data } = await lookup(baseEnv(), 'AAPL');
    assert.equal(status, 401);
    assert.equal(data.error, 'A premium session is required.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Tampered session cookie (bad signature) and no Bearer token: rejected.
{
  const { status } = await lookup(baseEnv(), 'AAPL', { Cookie: '__Host-vjm_session=garbage.notasignature' });
  assert.equal(status, 401);
}

// Valid session cookie, but Alpaca not configured: fails closed (503),
// never attempts the upstream call.
{
  const token = await signSession({ exp: Date.now() + 60000 }, SIGNING_SECRET);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Alpaca without keys configured'); };
  try {
    const { status, data } = await lookup(
      { SESSION_SIGNING_SECRET: SIGNING_SECRET }, 'AAPL', { Cookie: `__Host-vjm_session=${token}` }
    );
    assert.equal(status, 503);
    assert.equal(data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Legacy Bearer token: no PREMIUM_ACCESS_CODES configured means the legacy
// path is skipped entirely, so an unrelated Bearer token must not authorize.
{
  const { status } = await lookup(baseEnv(), 'AAPL', { Authorization: 'Bearer whatever' });
  assert.equal(status, 401);
}

// Legacy Bearer token: expired payload is rejected even with a correct signature.
{
  const token = await signLegacyToken({ exp: Date.now() - 1000 }, LEGACY_CODES);
  const { status } = await lookup(
    baseEnv({ PREMIUM_ACCESS_CODES: LEGACY_CODES }), 'AAPL', { Authorization: `Bearer ${token}` }
  );
  assert.equal(status, 401);
}

// Legacy Bearer token: forged signature (signed with the wrong secret) is rejected.
{
  const token = await signLegacyToken({ exp: Date.now() + 60000 }, 'wrong-secret');
  const { status } = await lookup(
    baseEnv({ PREMIUM_ACCESS_CODES: LEGACY_CODES }), 'AAPL', { Authorization: `Bearer ${token}` }
  );
  assert.equal(status, 401);
}

const originalFetch = globalThis.fetch;
try {
  // Legacy Bearer token: valid signature + unexpired exp authorizes, same as
  // the session-cookie path. This is the exact route research-engine.js
  // relies on during its migration window.
  {
    const token = await signLegacyToken({ exp: Date.now() + 60000 }, LEGACY_CODES);
    globalThis.fetch = async () => Response.json({
      AAPL: {
        latestTrade: { p: 150.5, t: '2026-08-30T12:00:00Z' },
        dailyBar: { c: 150.5, v: 1000000 },
        prevDailyBar: { c: 148, v: 900000 },
      },
    });
    const { status, data } = await lookup(
      baseEnv({ PREMIUM_ACCESS_CODES: LEGACY_CODES }), 'AAPL', { Authorization: `Bearer ${token}` }
    );
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.quote.price, 150.5);
  }

  const cookieHeaders = async () => {
    const token = await signSession({ exp: Date.now() + 60000 }, SIGNING_SECRET);
    return { Cookie: `__Host-vjm_session=${token}` };
  };

  // Top-level shape (symbol -> snapshot directly, no "snapshots" wrapper) --
  // the actual shape Alpaca returns today. Also pins marketCap staying null
  // (no shares-outstanding source on the free tier -- would be fabrication).
  {
    globalThis.fetch = async () => Response.json({
      AAPL: {
        latestTrade: { p: 150.5, t: '2026-08-30T12:00:00Z' },
        dailyBar: { c: 150.5, v: 1000000 },
        prevDailyBar: { c: 148, v: 900000 },
      },
    });
    const { status, data } = await lookup(baseEnv(), 'AAPL', await cookieHeaders());
    assert.equal(status, 200);
    assert.equal(data.quote.price, 150.5);
    assert.equal(data.quote.prevClose, 148);
    assert.ok(Math.abs(data.quote.change - 2.5) < 1e-9);
    assert.ok(Math.abs(data.quote.changePercent - (2.5 / 148) * 100) < 1e-9);
    assert.equal(data.quote.marketCap, null);
    assert.equal(data.tradingViewSymbol, 'NASDAQ:AAPL');
  }

  // Wrapped shape (data.snapshots.SYMBOL) must be accepted too, in case
  // Alpaca reverts to it -- same defensive fallback already fixed once
  // upstream in _lib/alpaca.js.
  {
    globalThis.fetch = async () => Response.json({
      snapshots: { AAPL: { latestTrade: { p: 151 }, prevDailyBar: { c: 148 } } },
    });
    const { status, data } = await lookup(baseEnv(), 'AAPL', await cookieHeaders());
    assert.equal(status, 200);
    assert.equal(data.quote.price, 151);
  }

  // Symbol absent from the snapshot map: fails as unavailable, not a thrown
  // error or a fabricated price.
  {
    globalThis.fetch = async () => Response.json({ MSFT: { latestTrade: { p: 400 } } });
    const { status, data } = await lookup(baseEnv(), 'AAPL', await cookieHeaders());
    assert.equal(status, 502);
    assert.equal(data.ok, false);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM premium-stock-research API tests passed.');
