// Regression coverage for the "stale feed" client-side label on
// forex-calendar.html.
//
// functions/api/forex-calendar.js falls back to a last-good cached copy
// (up to a day old) when the upstream ForexFactory feed is throttled, and
// deliberately marks that response `stale:true` with a `notice` explaining
// why -- see tests/forex-calendar-api.test.mjs. But the page's own client
// script only ever checked `data.ok`, so a throttled response rendered
// exactly like a fresh one: "Live feed" / "Live: N events loaded." A member
// timing an entry around a news release had no way to tell the forecast/
// actual figures on screen could be up to a day stale. Fixed by having the
// client also read `data.stale`/`data.notice` and label that case "Cached
// feed" / "Cached: ... not live" instead of silently calling it live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'forex-calendar.html'), 'utf8');

// The whole page app lives in one inline, unminified-into-multiple-tags
// <script>...</script> block starting at `const API_URL=`.
function extractAppScript() {
  const start = html.indexOf('const API_URL=');
  assert.ok(start > -1, 'const API_URL= not found in forex-calendar.html');
  const end = html.indexOf('\n</script>', start);
  assert.ok(end > -1, 'closing </script> not found after const API_URL=');
  return html.slice(start, end);
}

function makeEl() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    addEventListener() {},
    classList: { add() {}, remove() {}, contains: () => false },
  };
}

// Runs the page script in a sandbox with a stubbed DOM and fetch, then
// drives loadCalendar() once with the given API response.
async function runLoadCalendar(apiBody) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { document, addEventListener() {} };
  const sandbox = {
    document,
    window,
    console,
    fetch: async () => ({ ok: true, json: async () => apiBody }),
    Intl,
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractAppScript(), sandbox);
  await sandbox.loadCalendar();
  return elements;
}

const EVENT = { title: 'CPI m/m', country: 'USD', date: '2026-09-01T12:30:00Z', impact: 'High' };

test('a stale (throttled-feed) response is labeled cached, not live', async () => {
  const elements = await runLoadCalendar({
    ok: true,
    stale: true,
    notice: 'Live feed is throttled upstream; showing the last successfully fetched copy of the weekly calendar.',
    fetchedAt: '2026-08-30T09:00:00.000Z',
    events: [EVENT],
  });
  assert.equal(elements.get('feed-mode').textContent, 'Cached feed');
  assert.match(elements.get('feed-message').textContent, /throttled/);
  assert.match(elements.get('calendar-status').innerHTML, /Cached:/);
  assert.match(elements.get('calendar-status').innerHTML, /not live/);
  assert.doesNotMatch(elements.get('calendar-status').innerHTML, /^.*<strong>Live:<\/strong>/s);
});

test('a fresh response is still labeled live, unchanged', async () => {
  const elements = await runLoadCalendar({
    ok: true,
    stale: false,
    fetchedAt: '2026-09-01T09:00:00.000Z',
    events: [EVENT],
  });
  assert.equal(elements.get('feed-mode').textContent, 'Live feed');
  assert.match(elements.get('calendar-status').innerHTML, /<strong>Live:<\/strong>/);
  assert.doesNotMatch(elements.get('calendar-status').innerHTML, /Cached:/);
});

test('an unavailable (ok:false) response is still labeled blocked, unchanged', async () => {
  const elements = await runLoadCalendar({ ok: false, message: 'Calendar feed is temporarily unavailable.' });
  assert.equal(elements.get('feed-mode').textContent, 'Live feed blocked');
  assert.match(elements.get('calendar-status').innerHTML, /Live feed unavailable:/);
});

console.log('VJM forex-calendar stale-UI tests passed.');
