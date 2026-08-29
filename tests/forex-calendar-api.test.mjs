// Regression coverage for the forex-calendar impact filter (functions/api/forex-calendar.js).
//
// The page's default view and its "Red + Orange Folders" quick filter both
// call the API with impact=major and expect high AND medium impact USD
// events back; "Orange Folder Only" (impact=medium) expects medium only.
// A prior bug returned only high-impact rows for impact=major and both
// high+medium for impact=medium — the two most-used filters were broken.
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

async function titlesFor(impact) {
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/forex-calendar?currency=USD&impact=${impact}`),
    env: {},
  });
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
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
}

console.log('VJM forex-calendar impact filter tests passed.');
