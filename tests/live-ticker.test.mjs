// assets/live-ticker.js's marketSession() drives the OPEN/CLOSED/PRE-MARKET/
// AFTER-HOURS/OVERNIGHT badge shown on every symbol in the homepage's
// real-time tape — the only session-status indicator on the site, since the
// TradingView embed it augments serves delayed data and shows no live status
// of its own. The function is six weekday/time-boundary branches deep (the
// weekend-close window alone spans "Friday 8pm" through "Sunday 8pm", not a
// plain Saturday+Sunday check) and had zero behavioral coverage: the only
// existing references to this file (tests/pj-futures.test.mjs, a script-tag
// presence check; tests/palette.test.mjs, a CSS color-literal regex) never
// execute marketSession() itself. A single flipped comparison or mistyped
// MINS constant would silently mislabel the badge for every visitor, all
// day, with the full suite staying green. Extract the live function (plus
// its MINS/DAYNUM/HOLIDAYS constants) into a vm sandbox with a fixed Date,
// mirroring tests/pj-futures.test.mjs's pjNextSession fixed-time pattern,
// and pin the current (already-correct) behavior at each boundary, including
// the NYSE full-day-holiday override added after Thanksgiving/Christmas were
// found scoring as regular OPEN hours (see tests/regressions.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, 'assets', 'live-ticker.js'), 'utf8');

const minsSrc = src.match(/const MINS = \{[\s\S]*?\};/)[0];
const daynumSrc = src.match(/const DAYNUM = \{[\s\S]*?\};/)[0];
const holidaysSrc = src.match(/const HOLIDAYS = new Set\(\[[\s\S]*?\]\);/)[0];
const earlyCloseSrc = src.match(/const EARLY_CLOSE_DAYS = new Set\(\[[\s\S]*?\]\);/)[0];
const fnSrc = src.match(/function marketSession\(asset\) \{[\s\S]*?\n {2}\}/)[0];

// marketSession() calls `new Date()` with no arguments and reads it back out
// through the real Intl/ICU America/New_York conversion — only "now" needs
// faking, not the timezone math itself, so a Date subclass fixed to one
// instant is enough; the sandbox's fresh Intl/ICU built-ins do the rest.
function sessionAt(isoUtc, asset = 'equity') {
  const fixed = new Date(isoUtc);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixed.getTime()])); }
    static now() { return fixed.getTime(); }
  }
  const sandbox = { Date: FixedDate, Intl };
  vm.createContext(sandbox);
  vm.runInContext(
    minsSrc + '\n' + daynumSrc + '\n' + holidaysSrc + '\n' + earlyCloseSrc + '\n' + fnSrc +
      '\nthis.__result = marketSession(' + JSON.stringify(asset) + ');',
    sandbox,
  );
  return sandbox.__result;
}

test('marketSession: crypto is always 24/7, independent of time', () => {
  assert.equal(sessionAt('2026-09-19T16:00:00.000Z', 'crypto').code, '24/7');
});

test('marketSession: all of Saturday is CLOSED', () => {
  assert.equal(sessionAt('2026-09-19T16:00:00.000Z').code, 'CLOSED'); // Sat 12:00 ET
});

test('marketSession: Sunday stays CLOSED right up to 7:59pm ET', () => {
  assert.equal(sessionAt('2026-09-20T23:59:00.000Z').code, 'CLOSED'); // Sun 19:59 ET
});

test('marketSession: Sunday flips to OVERNIGHT exactly at 8:00pm ET', () => {
  assert.equal(sessionAt('2026-09-21T00:00:00.000Z').code, '🌙 OVERNIGHT'); // Sun 20:00 ET
});

test('marketSession: Friday stays AFTER HOURS right up to 7:59pm ET', () => {
  assert.equal(sessionAt('2026-09-18T23:59:00.000Z').code, '🌅 AFTER HOURS'); // Fri 19:59 ET
});

test('marketSession: Friday flips to CLOSED exactly at 8:00pm ET (weekend starts)', () => {
  assert.equal(sessionAt('2026-09-19T00:00:00.000Z').code, 'CLOSED'); // Fri 20:00 ET
});

test('marketSession: weekday morning is PRE-MARKET right up to 9:29am ET', () => {
  assert.equal(sessionAt('2026-09-21T13:29:00.000Z').code, '🌅 PRE-MARKET'); // Mon 09:29 ET
});

test('marketSession: weekday flips to OPEN exactly at 9:30am ET', () => {
  assert.equal(sessionAt('2026-09-21T13:30:00.000Z').code, 'OPEN'); // Mon 09:30 ET
});

test('marketSession: mid-afternoon on a weekday is OPEN', () => {
  assert.equal(sessionAt('2026-09-16T18:00:00.000Z').code, 'OPEN'); // Wed 14:00 ET
});

test('marketSession: weekday flips to AFTER HOURS exactly at 4:00pm ET', () => {
  assert.equal(sessionAt('2026-09-16T20:00:00.000Z').code, '🌅 AFTER HOURS'); // Wed 16:00 ET
});

test('marketSession: overnight (post-midnight, pre-4am) on a weekday is OVERNIGHT', () => {
  assert.equal(sessionAt('2026-09-15T06:00:00.000Z').code, '🌙 OVERNIGHT'); // Tue 02:00 ET
});

test('marketSession: overnight stays OVERNIGHT right up to 3:59am ET', () => {
  assert.equal(sessionAt('2026-09-21T07:59:00.000Z').code, '🌙 OVERNIGHT'); // Mon 03:59 ET
});

test('marketSession: flips from OVERNIGHT to PRE-MARKET exactly at 4:00am ET', () => {
  assert.equal(sessionAt('2026-09-21T08:00:00.000Z').code, '🌅 PRE-MARKET'); // Mon 04:00 ET
});

// Regression: Thanksgiving 2026-11-26 and Christmas 2026-12-25 are both
// ordinary weekdays by day-of-week/time-of-day math alone, but NYSE is fully
// closed both days — before HOLIDAYS existed, 11am ET on either date scored
// as regular OPEN hours (see tests/regressions.test.mjs for the incident).
test('marketSession: a full-day NYSE holiday on a weekday is CLOSED, not OPEN', () => {
  assert.equal(sessionAt('2026-11-26T16:00:00.000Z').code, 'CLOSED'); // Thu 11:00 ET, Thanksgiving
  assert.equal(sessionAt('2026-12-25T16:00:00.000Z').code, 'CLOSED'); // Fri 11:00 ET, Christmas
});

test('marketSession: a holiday overrides PRE-MARKET and AFTER HOURS too, not just OPEN', () => {
  assert.equal(sessionAt('2026-11-26T11:00:00.000Z').code, 'CLOSED'); // Thu 06:00 ET — would be PRE-MARKET
  assert.equal(sessionAt('2026-11-26T22:00:00.000Z').code, 'CLOSED'); // Thu 17:00 ET — would be AFTER HOURS
});

test('marketSession: the day after a holiday is unaffected (not stuck CLOSED)', () => {
  assert.equal(sessionAt('2026-11-27T16:00:00.000Z').code, 'OPEN'); // Fri 11:00 ET, day after Thanksgiving
});

// Regression: NYSE half-day early closes (1:00pm ET) are distinct from the
// full-day HOLIDAYS above and were previously invisible to this function —
// MINS.CLOSE stayed hardcoded at 4:00pm, so e.g. 2:00pm ET on the Friday
// after Thanksgiving scored as regular OPEN hours for a market that had
// actually been shut for an hour. 2027-12-24 is deliberately NOT in
// EARLY_CLOSE_DAYS: that year Christmas Day falls on a Saturday, so the
// 24th is already the observed full Christmas holiday in HOLIDAYS instead.
test('marketSession: an early-close day is still OPEN during the shortened 9:30am-1:00pm session', () => {
  assert.equal(sessionAt('2026-11-27T16:00:00.000Z').code, 'OPEN'); // Fri 11:00 ET, day after Thanksgiving
  assert.equal(sessionAt('2026-12-24T16:00:00.000Z').code, 'OPEN'); // Thu 11:00 ET, Christmas Eve
  assert.equal(sessionAt('2027-11-26T16:00:00.000Z').code, 'OPEN'); // Fri 11:00 ET, day after Thanksgiving
});

test('marketSession: an early-close day flips to AFTER HOURS at 1:00pm ET, not 4:00pm', () => {
  assert.equal(sessionAt('2026-11-27T19:00:00.000Z').code, '🌅 AFTER HOURS'); // Fri 14:00 ET
  assert.equal(sessionAt('2026-12-24T19:00:00.000Z').code, '🌅 AFTER HOURS'); // Thu 14:00 ET
  assert.equal(sessionAt('2027-11-26T19:00:00.000Z').code, '🌅 AFTER HOURS'); // Fri 14:00 ET
});

test('marketSession: an ordinary weekday afternoon is unaffected by the early-close list', () => {
  assert.equal(sessionAt('2026-09-16T19:00:00.000Z').code, 'OPEN'); // Wed 14:00 ET, not an early-close date
});

test('marketSession: 2027 Christmas Eve is the observed full holiday, not an early close', () => {
  assert.equal(sessionAt('2027-12-24T16:00:00.000Z').code, 'CLOSED'); // Fri 11:00 ET — observed Christmas
});

test('marketSession: every non-crypto session carries a distinct CSS class and a title', () => {
  const codes = new Map();
  for (const iso of [
    '2026-09-19T16:00:00.000Z', // CLOSED
    '2026-09-21T00:00:00.000Z', // OVERNIGHT
    '2026-09-21T13:29:00.000Z', // PRE-MARKET
    '2026-09-21T13:30:00.000Z', // OPEN
    '2026-09-16T20:00:00.000Z', // AFTER HOURS
  ]) {
    const s = sessionAt(iso);
    assert.ok(s.cls, `session at ${iso} must carry a CSS class`);
    assert.ok(s.title, `session at ${iso} must carry a descriptive title`);
    codes.set(s.code, s.cls);
  }
  assert.equal(codes.size, 5, 'the five sampled instants must land in five distinct session codes');
});

// Incident: tick() polled /api/ticker every 15s via setInterval with no
// document.hidden check anywhere in the file (unlike assets/funnel.js, the
// one other file on the site that reacts to tab visibility) -- so a visitor
// who opened the homepage and switched away kept the fetch firing into a
// backgrounded tab forever, burning Cloudflare Function invocations and the
// shared Alpaca IEX call budget for a tape nobody could see. This drives the
// real IIFE (the whole file, unmodified) in a vm sandbox with a controllable
// document.hidden and a counting fetch stub, proving the guard actually
// gates the network call rather than just asserting the source text.
function runTicker() {
  const fetchCalls = [];
  let hidden = false;
  let intervalFn = null;
  const listeners = {};
  const sandbox = {
    console,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      // ok:false short-circuits before build()/update() touch the DOM, so
      // the wrap/window stubs below never need more than this.
      return { json: async () => ({ ok: false }) };
    },
    setInterval: (fn) => { intervalFn = fn; return 1; },
    document: {
      getElementById: () => ({}),
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      get hidden() { return hidden; },
    },
    window: { matchMedia: () => ({ matches: false }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    fetchCalls,
    setHidden: (v) => { hidden = v; },
    nextInterval: () => intervalFn(),
    fireVisibilityChange: async () => { for (const fn of listeners.visibilitychange || []) await fn(); },
  };
}

test('live ticker: the initial load fetches even though the tab starts visible', async () => {
  const t = runTicker();
  await Promise.resolve();
  assert.equal(t.fetchCalls.length, 1, 'tick() should fetch once on load');
});

test('live ticker: a scheduled tick is skipped while the tab is hidden', async () => {
  const t = runTicker();
  await Promise.resolve();
  t.setHidden(true);
  await t.nextInterval();
  assert.equal(t.fetchCalls.length, 1, 'no new fetch should fire while document.hidden is true');
});

test('live ticker: a scheduled tick still fires normally while the tab is visible', async () => {
  const t = runTicker();
  await Promise.resolve();
  await t.nextInterval();
  assert.equal(t.fetchCalls.length, 2, 'the timer should keep polling as before while the tab is visible');
});

test('live ticker: returning to a hidden tab triggers an immediate catch-up fetch', async () => {
  const t = runTicker();
  await Promise.resolve();
  t.setHidden(true);
  await t.nextInterval();
  assert.equal(t.fetchCalls.length, 1, 'sanity check: still paused while hidden');
  t.setHidden(false);
  await t.fireVisibilityChange();
  assert.equal(t.fetchCalls.length, 2, 'becoming visible again should fetch fresh data right away, not wait up to 15s');
});

// Incident: the tape auto-scrolls indefinitely (raf() has no stop condition)
// for anyone without the OS-level prefers-reduced-motion flag, and the only
// pause triggers were mouseenter/mouseleave and pointer-drag -- both
// mouse/touch-only. A keyboard-only or screen-reader visitor had no way to
// stop a continuously-running animation shown alongside the rest of the
// page, a WCAG 2.2.2 (Pause, Stop, Hide) violation, and tabbing into a tape
// cell's own link meant watching it slide out from under the focus ring.
// This drives the real build()/raf() through a controllable
// requestAnimationFrame to prove the new button actually gates the scroll,
// not just that the markup carries the right attributes.
function makeTickerEl() {
  const attrs = {};
  const listeners = {};
  return {
    style: {},
    scrollWidth: 1200,
    textContent: '',
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setPointerCapture() {},
    listeners,
  };
}

// Cross-realm awaits (the vm sandbox has its own Promise/async-function
// intrinsics) don't settle within a fixed number of same-realm
// Promise.resolve() turns -- a macrotask boundary is the reliable way to
// let tick()'s two chained awaits (fetch, then res.json()) fully drain.
function flushMicrotasks() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// update() mutates cells in place via wrap.querySelectorAll('.lt-cell[data-sym="..."]')
// rather than rebuilding the markup -- this mock mirrors just enough of that
// lookup (keyed on the exact selector string the source generates, same
// technique makeTickerEl()'s elCache already uses) with two independent
// mock nodes per symbol, matching the real "both copies of the doubled row"
// comment in update() itself, so a fix that only updated one copy would be
// caught rather than passing on a mock that conflates them.
function makeCellMutable() {
  return { textContent: '', className: '', title: '' };
}
function makeCellGroup() {
  const price = makeCellMutable();
  const pct = makeCellMutable();
  const sess = makeCellMutable();
  return {
    title: '',
    price, pct, sess,
    querySelector(sel) {
      if (sel === '.lt-price') return price;
      if (sel === '.lt-pct') return pct;
      if (sel === '.lt-sess') return sess;
      return null;
    },
  };
}

function runTickerBuilt({ reducedMotion = false, items: initialItems } = {}) {
  let rafCb = null;
  let intervalFn = null;
  let currentItems = initialItems || ['AAA', 'BBB', 'CCC', 'DDD'].map((symbol) => (
    { symbol, label: symbol, price: 100, changePct: 1.2, asset: 'equity', tv: null }
  ));
  const elCache = new Map();
  const cellGroups = new Map(); // symbol -> [group, group], one per doubled-row copy
  const wrapEl = {
    set innerHTML(v) { this._html = v; elCache.clear(); },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      if (!elCache.has(sel)) elCache.set(sel, makeTickerEl());
      return elCache.get(sel);
    },
    querySelectorAll(sel) {
      const m = sel.match(/data-sym="([^"]*)"/);
      const sym = m ? m[1] : sel;
      if (!cellGroups.has(sym)) cellGroups.set(sym, [makeCellGroup(), makeCellGroup()]);
      return cellGroups.get(sym);
    },
  };
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({ ok: true, items: currentItems }) }),
    setInterval: (fn) => { intervalFn = fn; return 1; },
    requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
    getComputedStyle: () => ({ paddingLeft: '0px' }),
    performance: { now: () => 0 },
    document: {
      getElementById: (id) => (id === 'ticker-wrap' ? wrapEl : null),
      addEventListener: () => {},
      createElement: () => ({}),
      head: { appendChild: () => {} },
      hidden: false,
    },
    window: { matchMedia: () => ({ matches: reducedMotion }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    wrapEl,
    cellGroups,
    tick: (ts) => rafCb(ts),
    getRafCb: () => rafCb,
    ready: () => flushMicrotasks(),
    setItems: (next) => { currentItems = next; },
    // Fires the same setInterval callback tick() itself scheduled; since
    // build() already ran, this real-code path goes through update(), not
    // build() again -- exactly how a live 15s refresh behaves in production.
    pollAgain: async () => { await intervalFn(); await flushMicrotasks(); },
  };
}

test('live ticker: a keyboard-operable pause button actually stops the auto-scroll (WCAG 2.2.2)', async () => {
  const t = runTickerBuilt();
  await t.ready();

  const pauseBtn = t.wrapEl.querySelector('.lt-pause');
  const track = t.wrapEl.querySelector('.lt-track');
  assert.match(t.wrapEl.innerHTML, /class="lt-pause" aria-pressed="false"/, 'button starts unpaused per its initial markup');

  t.tick(0); // first frame just establishes lastTs, no movement yet
  const t0 = track.style.transform;
  t.tick(1000); // +1s unpaused
  const t1 = track.style.transform;
  assert.notEqual(t1, t0, 'sanity check: the tape must actually advance when nothing is pausing it');

  pauseBtn.listeners.click[0]();
  assert.equal(pauseBtn.getAttribute('aria-pressed'), 'true', 'clicking must flip aria-pressed so AT announces the new state');
  assert.equal(pauseBtn.getAttribute('aria-label'), 'Resume ticker');
  t.tick(2000); // +1s, but manually paused -- no hover or drag involved
  assert.equal(track.style.transform, t1, 'a keyboard click on the pause button must stop the scroll with no mouse involvement');

  pauseBtn.listeners.click[0]();
  assert.equal(pauseBtn.getAttribute('aria-pressed'), 'false');
  t.tick(3000); // +1s, unpaused again
  assert.notEqual(track.style.transform, t1, 'clicking the same button again must resume the scroll');
});

test('live ticker: the pause button is omitted when prefers-reduced-motion is already set', async () => {
  const t = runTickerBuilt({ reducedMotion: true });
  await t.ready();

  assert.equal(t.wrapEl.innerHTML.includes('lt-pause'), false, 'nothing auto-scrolls under reduced-motion, so there is nothing for the button to pause');
  assert.equal(t.getRafCb(), null, 'the raf loop itself must not start either');
});

// cellHtml(), fmtPrice(), fmtPct(), and tvHref() had zero behavioral coverage
// -- every reference to this file before now only drove marketSession() or
// the visibility/pause plumbing around it, never the markup those functions
// actually produce. A flipped >= to > in fmtPrice's thousands branch, a
// dropped '+' sign, or a swapped a/span tag choice would ship on every
// symbol in the tape with the full suite green. This drives the real
// build() (via the real tick()/fetch path, not an extracted copy of
// cellHtml) and asserts on the markup it actually writes to innerHTML.
test('live ticker: build() renders price formatting, pct sign/class, and the TradingView link correctly', async () => {
  // tick() requires at least 4 items before it will build/update at all
  // (its own ok:false-equivalent guard against a partial feed); pad with
  // two filler items so the two under test actually reach cellHtml().
  const items = [
    { symbol: 'BRK.A', label: 'BRK.A', price: 1234, changePct: 1.2, asset: 'equity', tv: 'BRKA' },
    { symbol: 'PENNY', label: 'PENNY', price: 86.5, changePct: -3.45, asset: 'equity', tv: null },
    { symbol: 'CCC', label: 'CCC', price: 50, changePct: 0, asset: 'equity', tv: null },
    { symbol: 'DDD', label: 'DDD', price: 50, changePct: 0, asset: 'equity', tv: null },
  ];
  const t = runTickerBuilt({ items });
  await t.ready();
  const html = t.wrapEl.innerHTML;

  // >=1000 branch: no decimals, with thousands grouping.
  assert.match(html, /<span class="lt-price">1,234<\/span>/, 'prices at or above 1000 drop decimals');
  // <1000 branch: fixed 2 decimals.
  assert.match(html, /<span class="lt-price">86\.50<\/span>/, 'prices under 1000 keep two decimals');

  // Sign and up/down class must track changePct, not just its magnitude.
  assert.match(html, /<span class="lt-pct up">\+1\.20%<\/span>/, 'a positive changePct gets a leading + and the up class');
  assert.match(html, /<span class="lt-pct down">-3\.45%<\/span>/, 'a negative changePct gets the down class and keeps its own sign');

  // tv set -> a real link; tv null -> a plain span with no href to break.
  assert.match(html, /<a class="lt-cell" data-sym="BRK\.A" href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=BRKA" target="_blank" rel="noopener"/, 'an item with tv set renders as a clickable TradingView link');
  assert.match(html, /<span class="lt-cell" data-sym="PENNY"[^>]*>/, 'an item with no tv renders as a plain span, not a dead link');
  assert.equal(/<span class="lt-cell" data-sym="PENNY"[^>]*href=/.test(html), false, 'the no-tv cell must carry no href at all');
});

// esc()'s own comment states the invariant this test pins: quote data from
// /api/ticker passes through a third-party API on the way, so nothing may
// reach innerHTML unescaped. Nothing before this exercised that promise --
// a dropped esc() call around item.symbol or item.label would inject
// attacker-controlled markup straight into the homepage on every page load.
test('live ticker: build() escapes hostile symbol/label text instead of injecting raw markup', async () => {
  const items = [
    { symbol: '<img src=x onerror=alert(1)>', label: '"></span><script>1</script>', price: 1, changePct: 0, asset: 'equity', tv: null },
    { symbol: 'BBB', label: 'BBB', price: 1, changePct: 0, asset: 'equity', tv: null },
    { symbol: 'CCC', label: 'CCC', price: 1, changePct: 0, asset: 'equity', tv: null },
    { symbol: 'DDD', label: 'DDD', price: 1, changePct: 0, asset: 'equity', tv: null },
  ];
  const t = runTickerBuilt({ items });
  await t.ready();
  const html = t.wrapEl.innerHTML;

  assert.equal(html.includes('<img src=x'), false, 'a raw <img> tag from item.symbol must never reach innerHTML');
  assert.equal(html.includes('<script>1</script>'), false, 'a raw <script> tag from item.label must never reach innerHTML');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile symbol must come through HTML-entity-escaped');
  assert.ok(html.includes('&quot;&gt;&lt;/span&gt;&lt;script&gt;1&lt;/script&gt;'), 'the hostile label must come through HTML-entity-escaped');
});

// Incident risk: cellHtml() (build) and update() independently recompute the
// same price/pct/session rendering from the same item fields -- nothing
// proved they agree. A change to one without the other would leave the
// initial paint correct but every 15s refresh silently stale or wrong,
// since update() is the only code path a long-lived tab actually revisits.
// Drives the real tick() -> update() path a second time through the same
// setInterval callback production schedules, not a direct call to update().
test('live ticker: a later poll updates price, pct sign, and class in place via update()', async () => {
  const sym = 'AAA';
  const others = ['BBB', 'CCC', 'DDD'].map((s) => (
    { symbol: s, label: s, price: 1, changePct: 0, asset: 'equity', tv: null }
  ));
  const t = runTickerBuilt({ items: [
    { symbol: sym, label: sym, price: 100, changePct: 1.2, asset: 'equity', tv: null },
    ...others,
  ] });
  await t.ready();

  t.setItems([
    { symbol: sym, label: sym, price: 2501.4, changePct: -3.45, asset: 'equity', tv: null },
    ...others,
  ]);
  await t.pollAgain();

  const groups = t.cellGroups.get(sym);
  assert.ok(groups, 'update() must look up the cell by the same data-sym selector build() rendered');
  for (const g of groups) {
    assert.equal(g.price.textContent, '2,501', 'update() must re-render the new price through the same >=1000 formatting rule');
    assert.equal(g.pct.textContent, '-3.45%', 'update() must re-render the new, sign-flipped pct text');
    assert.equal(g.pct.className, 'lt-pct down', 'update() must flip the pct class to match the new sign, not leave the stale up class');
  }
});
