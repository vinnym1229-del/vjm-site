// Incident: forex-calendar.html's loadCalendar() and loadYahooNews() had no
// request-sequencing guard, the same bug class already fixed this cycle in
// index.html's checkStatus() (tests/status-checker-race.test.mjs) and
// stock-lab.html's loadNews()/runBasicResearch()/runPremiumResearch()
// (tests/stock-lab-symbol-race.test.mjs). This page's "Refresh", "Refresh
// News", and "Refresh Now" buttons re-trigger these same two functions,
// which also auto-fire once on DOMContentLoaded -- so a visitor who clicks
// Refresh while the page's own initial load is still in flight, or
// double-clicks a refresh button out of impatience, can have an OLDER fetch
// resolve AFTER a newer one and silently overwrite fresher data with stale
// data. This page explicitly models an upstream feed that can be slow or
// throttled (`data.stale`/`data.notice`), so uneven per-request latency is
// an expected condition here, not a rare edge case -- a trader could see
// the event table, the Today/Next-24h stats, or the "Live feed"/"Cached
// feed" status badge flip backward to a stale copy with no error shown.
//
// Fixed with the same monotonically increasing per-call sequence counter
// (calSeq/newsSeq) the two prior fixes use: each function captures its own
// request id before the fetch and discards the result if a newer call of
// that same function has already started by the time it resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'forex-calendar.html'), 'utf8');

// Mirrors tests/forex-calendar-stale-ui.test.mjs's own extraction helper --
// the whole page app lives in one inline <script> block starting at
// `const API_URL=`.
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

// A fetch stub that never resolves on its own -- it hands back a new
// pending promise per call (pushed onto `pending` in call order) so a test
// can settle overlapping calls in whatever order it chooses, including the
// out-of-order case real network timing can produce.
function makeSandbox() {
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
  const pending = [];
  const sandbox = {
    document,
    window,
    console,
    fetch: () => new Promise((resolve) => pending.push(resolve)),
    Intl,
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractAppScript(), sandbox);
  return { sandbox, elements, pending };
}

const EVENT_OLD = { title: 'Old CPI release', country: 'USD', date: '2026-09-01T12:30:00Z', impact: 'High' };
const EVENT_NEW = { title: 'New NFP release', country: 'USD', date: '2026-09-02T12:30:00Z', impact: 'High' };

test('loadCalendar() discards a stale response that resolves after a newer call has started', async () => {
  const { sandbox, elements, pending } = makeSandbox();

  const first = sandbox.loadCalendar(); // older call, in flight
  const second = sandbox.loadCalendar(); // newer call, started before the older one resolved
  assert.equal(pending.length, 2, 'both overlapping calls must each issue their own fetch');

  pending[1]({ ok: true, json: async () => ({ ok: true, events: [EVENT_NEW], fetchedAt: '2026-09-02T09:00:00.000Z' }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ ok: true, events: [EVENT_OLD], fetchedAt: '2026-09-01T09:00:00.000Z' }) });
  await first;

  assert.match(elements.get('calendar-table').innerHTML, /New NFP release/,
    "the stale older call's response must not overwrite the newer call's events");
  assert.doesNotMatch(elements.get('calendar-table').innerHTML, /Old CPI release/);
});

test('loadCalendar() still renders a response that resolves in call order', async () => {
  const { sandbox, elements, pending } = makeSandbox();
  const call = sandbox.loadCalendar();
  pending[0]({ ok: true, json: async () => ({ ok: true, events: [EVENT_NEW], fetchedAt: '2026-09-02T09:00:00.000Z' }) });
  await call;
  assert.match(elements.get('calendar-table').innerHTML, /New NFP release/);
});

test('loadYahooNews() discards a stale headline response that resolves after a newer call has started', async () => {
  const { sandbox, elements, pending } = makeSandbox();

  const first = sandbox.loadYahooNews();
  const second = sandbox.loadYahooNews();
  assert.equal(pending.length, 2, 'both overlapping calls must each issue their own fetch');

  pending[1]({ ok: true, json: async () => ({ ok: true, items: [{ title: 'New market headline' }] }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ ok: true, items: [{ title: 'Old market headline' }] }) });
  await first;

  assert.match(elements.get('finance-news').innerHTML, /New market headline/,
    "the stale older call's response must not overwrite the newer call's headlines");
  assert.doesNotMatch(elements.get('finance-news').innerHTML, /Old market headline/);
});

test('loadYahooNews() still renders a response that resolves in call order', async () => {
  const { sandbox, elements, pending } = makeSandbox();
  const call = sandbox.loadYahooNews();
  pending[0]({ ok: true, json: async () => ({ ok: true, items: [{ title: 'Latest market headline' }] }) });
  await call;
  assert.match(elements.get('finance-news').innerHTML, /Latest market headline/);
});

console.log('VJM forex-calendar race tests passed.');
