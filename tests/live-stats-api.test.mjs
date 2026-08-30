// Regression coverage for /api/live-stats (functions/api/live-stats.js).
//
// This was the last functions/api/*.js file with zero test references. It's
// a public read that fans out to two third parties (Discord's public invite
// endpoint, Whop's REST API) and its own comments promise each half "never
// breaks the page" -- Whop falls back to the site's static numbers when
// unconfigured, and either half degrades to null on a failed/erroring fetch
// rather than surfacing an error or throwing. Pins: the rate-limit guard
// trips before either third-party call, Whop is skipped entirely (not
// attempted) when WHOP_API_KEY/WHOP_PRODUCT_ID are absent, a non-200 or
// throwing response from either upstream degrades that half to null without
// touching the other, a fully successful pull shapes both halves correctly,
// and the 5-minute edge-cache header the run cycle depends on to absorb
// polling from every page load.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/live-stats.js';

function whopEnv() {
  return { WHOP_API_KEY: 'key', WHOP_PRODUCT_ID: 'prod_123' };
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.4.0.${ipCounter}`;
}

async function call(env, ip) {
  const res = await onRequestGet({
    request: new Request('https://example.com/api/live-stats', {
      headers: { 'CF-Connecting-IP': ip },
    }),
    env,
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

// Rate limit trips before either third-party call (60/min) -- proven with a
// fetch that throws if reached at all, so a leaked call fails the test loudly.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call a third party while rate-limit gating the request'); };
  try {
    const ip = nextIp();
    let last;
    for (let i = 0; i < 60; i++) last = await call({}, ip);
    assert.equal(last.status, 200);

    const limited = await call({}, ip);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalFetch = globalThis.fetch;
try {
  // Whop unconfigured: skipped entirely (not attempted). The mock answers
  // any whop.com call with real-looking member data, so if the missing-key
  // guard were ever dropped, whop would come back populated instead of null
  // -- the assertion below would catch that, not just a thrown error.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.whop.com')) return Response.json({ member_count: 999, published_reviews_count: 1 });
      return Response.json({ approximate_member_count: 5000, approximate_presence_count: 800 });
    };
    const { status, headers, data } = await call({}, nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.deepEqual(data.discord, { memberCount: 5000, onlineCount: 800 });
    assert.equal(data.whop, null, 'whop must be skipped, not fetched, when unconfigured');
    assert.ok(data.asOf, 'asOf timestamp missing');
    assert.match(headers.get('Cache-Control') || '', /max-age=300/);
  }

  // Both configured and both succeed: shapes both halves from their
  // respective response fields.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.whop.com')) {
        return Response.json({ member_count: 1200, published_reviews_count: 49 });
      }
      return Response.json({ approximate_member_count: 5000, approximate_presence_count: 800 });
    };
    const { status, data } = await call(whopEnv(), nextIp());
    assert.equal(status, 200);
    assert.deepEqual(data.discord, { memberCount: 5000, onlineCount: 800 });
    assert.deepEqual(data.whop, { memberCount: 1200, reviewCount: 49 });
  }

  // Discord upstream errors (non-200): degrades to null, Whop half unaffected.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.whop.com')) {
        return Response.json({ member_count: 1200, published_reviews_count: 49 });
      }
      return new Response('down', { status: 500 });
    };
    const { status, data } = await call(whopEnv(), nextIp());
    assert.equal(status, 200);
    assert.equal(data.discord, null);
    assert.deepEqual(data.whop, { memberCount: 1200, reviewCount: 49 });
  }

  // Whop configured but the call throws (network failure): degrades to
  // null rather than surfacing an error or failing the whole response.
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.whop.com')) throw new Error('network down');
      return Response.json({ approximate_member_count: 5000, approximate_presence_count: 800 });
    };
    const { status, data } = await call(whopEnv(), nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.whop, null);
    assert.deepEqual(data.discord, { memberCount: 5000, onlineCount: 800 });
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM live-stats API tests passed.');
