// index.html's inline script bootstraps the toggle's OWN label separately
// from assets/theme.js (which only ever touches body's class list, never the
// button). options-lab.html's identical late-script block already uses the
// correct "stored !== 'dark'" rule that matches theme.js's actual default
// (LIGHT unless explicitly opted out), but index.html's had only ever checked
// "stored === 'light'" -- a leftover from before the site-wide default flipped
// from dark to light (2026-09-01). Net effect: a first-time visitor with
// nothing in localStorage landed on the homepage correctly rendered in light
// mode (theme.js's job), but the toggle button still read "Dark" with a moon
// icon -- exactly backwards for what one click would actually do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');

// The dark/light-mode functions plus their own load-time sync IIFE sit
// between these two comment markers as plain (non-minified) inline script --
// the TradingView ticker block in between is theme-aware too (it rebuilds on
// 'vjm:themechange') and its own IIFE runs immediately, so it has to come
// along; it no-ops harmlessly here since #tv-ticker isn't in this sandbox.
const START = '// ─── DARK / LIGHT MODE ───';
const END = '// ─── STREAM COUNTDOWN';
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx,
  'could not locate the DARK / LIGHT MODE script block in index.html');
const themeSrc = html.slice(startIdx, endIdx);

test('index.html still ships themeButtonHtml/toggleTheme and its own load-time sync IIFE', () => {
  assert.match(themeSrc, /function themeButtonHtml/);
  assert.match(themeSrc, /function toggleTheme/);
  assert.match(themeSrc, /\(function\(\) \{[\s\S]*document\.getElementById\('theme-toggle'\)\.innerHTML/,
    'expected a self-invoking sync block that sets the toggle button innerHTML on load');
});

function run(stored) {
  const store = new Map();
  if (stored !== null) store.set('st-theme', stored);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const bodyClasses = new Set();
  // Seeded to the real static markup's default (index.html's button starts
  // as moon-icon "Dark" before any script touches it) so a script path that
  // simply never updates the label -- the pre-fix bug -- is distinguishable
  // from one that correctly re-states "Dark".
  let toggleInnerHTML = '&#127769; <span id="theme-label">Dark</span>';
  const sandbox = {
    console,
    localStorage,
    document: {
      getElementById: (id) => (id === 'theme-toggle' ? {
        set innerHTML(v) { toggleInnerHTML = v; },
        get innerHTML() { return toggleInnerHTML; },
      } : null),
      body: {
        classList: {
          add: (c) => bodyClasses.add(c),
          toggle(c, force) {
            const on = force === undefined ? !bodyClasses.has(c) : !!force;
            on ? bodyClasses.add(c) : bodyClasses.delete(c);
            return on;
          },
          contains: (c) => bodyClasses.has(c),
        },
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Drop the trailing TradingView-ticker IIFE reference-free: only the
  // dark/light block is needed, and it is fully self-contained.
  vm.runInContext(themeSrc, sandbox, { filename: 'index.html#theme-block' });
  return { bodyClasses, toggleInnerHTML };
}

test('a fresh visitor with nothing stored gets light-mode AND a toggle label that says "Light"', () => {
  const { bodyClasses, toggleInnerHTML } = run(null);
  assert.equal(bodyClasses.has('light-mode'), true, 'default should be light-mode on <body>');
  assert.match(toggleInnerHTML, /Light/, 'toggle button must say "Light", not be stuck on the pre-2026-09-01 default');
  assert.doesNotMatch(toggleInnerHTML, /Dark/);
});

test('an explicit stored "dark" keeps dark mode and labels the toggle "Dark"', () => {
  const { bodyClasses, toggleInnerHTML } = run('dark');
  assert.equal(bodyClasses.has('light-mode'), false);
  assert.match(toggleInnerHTML, /Dark/);
});

test('an explicit stored "light" keeps light mode and labels the toggle "Light" (pre-existing case, unchanged)', () => {
  const { bodyClasses, toggleInnerHTML } = run('light');
  assert.equal(bodyClasses.has('light-mode'), true);
  assert.match(toggleInnerHTML, /Light/);
});
