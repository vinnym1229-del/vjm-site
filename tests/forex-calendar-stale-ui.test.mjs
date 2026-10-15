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

// A quick-filter button stub that actually tracks its own active class and
// aria-pressed attribute, and lets a test fire the click handler the page
// script registers on it.
function makeQuickButton(impact, range, active) {
  const classes = new Set(active ? ['active'] : []);
  const attrs = { 'aria-pressed': active ? 'true' : 'false' };
  const listeners = {};
  return {
    dataset: { impact, range },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(name, value) { attrs[name] = value; },
    getAttribute(name) { return attrs[name]; },
    addEventListener(ev, fn) { listeners[ev] = fn; },
    fire(ev) { listeners[ev](); },
  };
}

// A <select>/<input> stub whose addEventListener actually registers a
// handler a test can trigger via dispatch(), unlike makeEl()'s no-op.
function makeControl(value) {
  const listeners = {};
  return {
    value,
    addEventListener(ev, fn) { listeners[ev] = fn; },
    dispatch(ev) { listeners[ev](); },
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

// Incident: the five ".quick button" pills (e.g. "USD Red + Orange - Week",
// "Today") only ever synced INTO the #impact/#range <select> elements, on
// click. The selects' own "change" listener called renderAll() but never
// touched the buttons' "active" class, so a visitor who changed either
// dropdown directly saw a quick-filter pill stay highlighted for a filter
// that was no longer applied -- e.g. the page loads on "Week" highlighted,
// the visitor sets the Range dropdown to "Today only", and the table
// correctly shows today's events while the "Week" pill still looks selected.
function setupQuickButtonSandbox() {
  const elements = new Map(['search', 'impact', 'range'].map((id) => [id, makeControl(id === 'search' ? '' : id === 'impact' ? 'major' : 'week')]));
  for (const id of ['feed-mode', 'feed-message', 'calendar-status', 'calendar-table', 'stat-total', 'stat-high-today', 'stat-medium-today', 'stat-updated']) {
    elements.set(id, makeEl());
  }
  const quickButtons = [
    makeQuickButton('major', 'week', true),
    makeQuickButton('High', 'week', false),
    makeQuickButton('Medium', 'week', false),
    makeQuickButton('major', 'today', false),
    makeQuickButton('major', 'next24', false),
  ];
  const document = {
    getElementById(id) { return elements.get(id); },
    querySelectorAll(sel) { return sel === '.quick button[data-impact]' ? quickButtons : []; },
    addEventListener() {},
  };
  const window = { document, addEventListener() {} };
  const sandbox = { document, window, console, fetch: async () => ({ ok: true, json: async () => ({ ok: true, events: [] }) }), Intl, Date };
  vm.createContext(sandbox);
  vm.runInContext(extractAppScript(), sandbox);
  const active = () => quickButtons.filter((b) => b.classList.contains('active')).map((b) => `${b.dataset.impact}/${b.dataset.range}`);
  const pressed = () => quickButtons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => `${b.dataset.impact}/${b.dataset.range}`);
  return { elements, quickButtons, active, pressed };
}

test('changing the Range dropdown directly updates which quick-filter pill is highlighted', () => {
  const { elements, active } = setupQuickButtonSandbox();
  assert.deepEqual(active(), ['major/week'], 'page loads with the Week pill active');
  elements.get('range').value = 'today';
  elements.get('range').dispatch('change');
  assert.deepEqual(active(), ['major/today'], 'Today pill must light up, not stay on Week');
});

test('changing the Impact dropdown directly updates which quick-filter pill is highlighted', () => {
  const { elements, active } = setupQuickButtonSandbox();
  elements.get('impact').value = 'High';
  elements.get('impact').dispatch('change');
  assert.deepEqual(active(), ['High/week'], 'Red Folder Only pill must light up, not stay on Week');
});

test('a dropdown combination no quick-filter pill represents leaves none highlighted', () => {
  const { elements, active } = setupQuickButtonSandbox();
  elements.get('range').value = 'future';
  elements.get('range').dispatch('change');
  assert.deepEqual(active(), [], 'no pill claims to represent "Future only" alone');
});

test('clicking a quick-filter pill still sets both dropdowns and highlights itself', () => {
  const { elements, quickButtons, active } = setupQuickButtonSandbox();
  quickButtons[3].fire('click'); // "Today" button: data-impact="major" data-range="today"
  assert.equal(elements.get('impact').value, 'major');
  assert.equal(elements.get('range').value, 'today');
  assert.deepEqual(active(), ['major/today']);
});

// Incident: syncQuickButtons() only ever toggled the ".active" CSS class,
// the same visual-only signal fixed on ~10 other toggle-button widgets
// across this site (premTab, setAnalystYears, period/sim/gain-mode tabs,
// etc. -- see decisions.md). A screen-reader or keyboard-only visitor
// tabbing through these 5 filter pills heard five identical "button"s with
// no indication which preset, if any, was applied. Fixed by having
// syncQuickButtons() also set aria-pressed alongside the class toggle.
test('the quick-filter pills carry aria-pressed in sync with the active class', () => {
  const { pressed } = setupQuickButtonSandbox();
  assert.deepEqual(pressed(), ['major/week'], 'page loads with the Week pill marked pressed');
});

test('changing a dropdown directly updates aria-pressed, not just the active class', () => {
  const { elements, pressed } = setupQuickButtonSandbox();
  elements.get('range').value = 'today';
  elements.get('range').dispatch('change');
  assert.deepEqual(pressed(), ['major/today'], 'Today pill must become aria-pressed, Week pill must not stay pressed');
});

test('a dropdown combination no pill represents leaves none aria-pressed', () => {
  const { elements, pressed } = setupQuickButtonSandbox();
  elements.get('range').value = 'future';
  elements.get('range').dispatch('change');
  assert.deepEqual(pressed(), []);
});

test('clicking a quick-filter pill sets its own aria-pressed to true', () => {
  const { quickButtons, pressed } = setupQuickButtonSandbox();
  quickButtons[3].fire('click'); // "Today" button
  assert.deepEqual(pressed(), ['major/today']);
});

console.log('VJM forex-calendar stale-UI tests passed.');
