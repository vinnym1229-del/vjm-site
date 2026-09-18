// Regression coverage for premarket.html's mover coloring.
//
// functions/api/_lib/alpaca.js's movers() (the real Alpaca screener path
// market-brief.js tries first) does not filter out a row whose upstream
// price_change_percent was missing -- unlike its own computedMovers()
// fallback, which explicitly drops any row with changePct===null. So a
// genuine loser can reach the client with changePct:null. premarket.html's
// own pctCls() read `m.changePct||0`, and 0 is not negative, so that
// unavailable mover rendered class="num pos" -- the GAIN color -- right next
// to fmtPct's own "—" for the same value: a loser shown in green. Fixed by
// switching to the same Number.isFinite guard assets/live-ticker.js already
// uses for this identical problem, so an unavailable change reads neutral
// (no color class) instead of a false gain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'premarket.html'), 'utf8');

// The whole page app lives in one inline <script>...</script> block starting
// at `const $ = (id) =>` and ending right before its own `load();` call --
// stripped here so the test can invoke load() itself, once per case, with
// its own mocked fetch, the same seam tests/forex-calendar-stale-ui.test.mjs
// uses for forex-calendar.html's sibling script.
function extractAppScript() {
  const start = html.indexOf('const $ = (id) => document.getElementById(id);');
  assert.ok(start > -1, 'const $ = (id) => ... not found in premarket.html');
  const end = html.indexOf('  load();', start);
  assert.ok(end > -1, 'load(); call not found after the const $ declaration');
  return html.slice(start, end) + '\nthis.load = load;\n';
}

function makeEl() {
  return { textContent: '', innerHTML: '', value: '', className: '' };
}

// Runs the page script in a sandbox with a stubbed DOM, then drives load()
// once with the given /api/market-brief response.
async function runLoad(apiBody) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    },
  };
  const sandbox = {
    document, console, Date,
    fetch: async () => ({ ok: true, json: async () => apiBody }),
  };
  vm.createContext(sandbox);
  vm.runInContext(extractAppScript(), sandbox);
  await sandbox.load();
  return elements;
}

test('movers with a real gain or loss are colored pos/neg', async () => {
  const elements = await runLoad({
    ok: true,
    generatedAt: '2026-09-18T09:00:00.000Z',
    movers: {
      gainers: [{ symbol: 'NVDA', changePct: 2.5 }],
      losers: [{ symbol: 'TSLA', changePct: -1.2 }],
      source: 'test',
    },
  });
  assert.match(elements.get('gainers').innerHTML, /class="num pos">\+2\.50%/);
  assert.match(elements.get('losers').innerHTML, /class="num neg">-1\.20%/);
});

test('a mover with an unavailable change percent is not colored as a gain', async () => {
  const elements = await runLoad({
    ok: true,
    generatedAt: '2026-09-18T09:00:00.000Z',
    movers: {
      gainers: [],
      losers: [{ symbol: 'XYZ', changePct: null }],
      source: 'test',
    },
  });
  const losers = elements.get('losers').innerHTML;
  assert.match(losers, />—</, 'an unavailable change percent must still show the "—" placeholder');
  assert.doesNotMatch(losers, /class="num pos"/, 'an unavailable mover must never render the gain (green) class');
  assert.doesNotMatch(losers, /class="num neg"/, 'an unavailable mover has no known direction either');
});

console.log('VJM premarket-brief UI tests passed.');
