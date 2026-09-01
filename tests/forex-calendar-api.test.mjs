// Regression coverage for functions/api/forex-calendar.js.
//
// The page's default view and its "Red + Orange Folders" quick filter both
// call the API with impact=major and expect high AND medium impact USD
// events back; "Orange Folder Only" (impact=medium) expects medium only.
// A prior bug returned only high-impact rows for impact=major and both
// high+medium for impact=medium — the two most-used filters were broken.
//
// Everything past the impact filter itself was still untested: the 30/min
// rate-limit guard, the 400 an invalid impact value gets, the unsupported-
// currency fallback to USD, currency=ALL widening past USD, and the two
// upstream-failure branches this endpoint's own header comment promises —
// fail closed with a 502 when there's no cached copy to fall back to, and
// serve the last good copy (labeled stale) when there is one, since
// faireconomy throttles Cloudflare's shared egress IPs for stretches.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/forex-calendar.js';

const FIXTURE = [
  { title: 'CPI m/m', country: 'USD', date: '2026-09-01T12:30:00Z', impact: 'High' },
  { title: 'Retail Sales m/m', country: 'USD', date: '2026-09-02T12:30:00Z', impact: 'Medium' },
  { title: 'Trade Balance', country: 'USD', date: '2026-09-03T12:30:00Z', impact: 'Low' },
  { title: 'ECB Press Conference', country: 'EUR', date: '2026-09-04T12:30:00Z', impact: 'High' },
];

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
globalThis.fetch = async () => Response.json(FIXTURE);
globalThis.caches = { default: { put: async () => {}, match: async () => null } };

async function call(url, ip = '10.5.0.1') {
  return onRequestGet({
    request: new Request(url, { headers: { 'CF-Connecting-IP': ip } }),
    env: {},
  });
}

async function titlesFor(impact, currency = 'USD') {
  const res = await call(`https://example.com/api/forex-calendar?currency=${currency}&impact=${impact}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  return data.events.map((e) => e.title).sort();
}

try {
  assert.deepEqual(
    await titlesFor('major'),
    ['CPI m/m', 'Retail Sales m/m'],
    'impact=major (Red + Orange Folders, the page default) must include both high and medium USD events',
  );
  assert.deepEqual(
    await titlesFor('high'),
    ['CPI m/m'],
    'impact=high (Red Folder Only) must exclude medium events',
  );
  assert.deepEqual(
    await titlesFor('medium'),
    ['Retail Sales m/m'],
    'impact=medium (Orange Folder Only) must exclude high events',
  );
  assert.deepEqual(
    await titlesFor('major', 'EUR'),
    ['CPI m/m', 'Retail Sales m/m'],
    'an unsupported currency value must fall back to USD, not pass the caller-controlled value through',
  );
  assert.deepEqual(
    await titlesFor('major', 'ALL'),
    ['CPI m/m', 'ECB Press Conference', 'Retail Sales m/m'],
    'currency=ALL must widen the result past USD instead of being ignored',
  );

  {
    const res = await call('https://example.com/api/forex-calendar?impact=extreme');
    assert.equal(res.status, 400, 'an impact value outside major/high/medium must 400, not fall through as an open filter');
    const data = await res.json();
    assert.equal(data.ok, false);
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}

// Rate limit (30/min) trips before the upstream feed is ever fetched again --
// proven by counting real fetch invocations, not just reading status codes.
{
  const originalFetch2 = globalThis.fetch;
  const originalCaches2 = globalThis.caches;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return Response.json(FIXTURE); };
  globalThis.caches = { default: { put: async () => {}, match: async () => null } };
  try {
    const ip = '10.5.0.2';
    let last;
    for (let i = 0; i < 30; i++) last = await call('https://example.com/api/forex-calendar?impact=major', ip);
    assert.equal(last.status, 200);
    assert.equal(fetchCalls, 30, 'the 30 allowed requests must each reach the upstream feed');

    const limited = await call('https://example.com/api/forex-calendar?impact=major', ip);
    assert.equal(limited.status, 429);
    const data = await limited.json();
    assert.equal(data.ok, false);
    assert.equal(fetchCalls, 30, 'the 31st request must be blocked before it ever reaches the upstream feed');
  } finally {
    globalThis.fetch = originalFetch2;
    globalThis.caches = originalCaches2;
  }
}

// Upstream failure with no cached copy fails closed (502), never a fabricated
// or empty-but-200 calendar.
{
  const originalFetch3 = globalThis.fetch;
  const originalCaches3 = globalThis.caches;
  globalThis.fetch = async () => { throw new Error('feed unreachable'); };
  globalThis.caches = { default: { put: async () => {}, match: async () => null } };
  try {
    const res = await call('https://example.com/api/forex-calendar?impact=major', '10.5.0.3');
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.detail, /feed unreachable/);
  } finally {
    globalThis.fetch = originalFetch3;
    globalThis.caches = originalCaches3;
  }
}

// Upstream failure with a held cached copy re-serves it labeled stale, with
// the notice pointing at the throttling rather than a generic error.
{
  const originalFetch4 = globalThis.fetch;
  const originalCaches4 = globalThis.caches;
  const staleFrom = '2026-08-30T09:00:00.000Z';
  const held = new Response(JSON.stringify(FIXTURE), {
    headers: { 'Content-Type': 'application/json', 'X-Fetched-At': staleFrom },
  });
  globalThis.fetch = async () => { throw new Error('feed throttled'); };
  globalThis.caches = { default: { put: async () => {}, match: async () => held } };
  try {
    const res = await call('https://example.com/api/forex-calendar?impact=major', '10.5.0.4');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.stale, true);
    assert.equal(data.cached, true);
    assert.equal(data.fetchedAt, staleFrom, 'a stale response must report when the cached copy was actually fetched, not now');
    assert.match(data.notice, /throttled/);
    assert.deepEqual(data.events.map((e) => e.title).sort(), ['CPI m/m', 'Retail Sales m/m']);
  } finally {
    globalThis.fetch = originalFetch4;
    globalThis.caches = originalCaches4;
  }
}

console.log('VJM forex-calendar API tests passed.');
