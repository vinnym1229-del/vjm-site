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
// its MINS/DAYNUM constants) into a vm sandbox with a fixed Date, mirroring
// tests/pj-futures.test.mjs's pjNextSession fixed-time pattern, and pin the
// current (already-correct) behavior at each boundary.
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
    minsSrc + '\n' + daynumSrc + '\n' + fnSrc + '\nthis.__result = marketSession(' + JSON.stringify(asset) + ');',
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
