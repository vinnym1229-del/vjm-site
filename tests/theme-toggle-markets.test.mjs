// The three remaining tool pages named in board.md row 3 (forex-calendar,
// premarket, prop-firms) all ship assets/theme.js's default-light bootstrap
// -- forex-calendar.html with its own full light-mode CSS block, premarket.html
// and prop-firms.html riding assets/tokens.css's shared --vjm-* light-mode
// variables -- but none had a #theme-toggle control, so a visitor who landed
// in light mode had no way back to dark. Same defect class as the curriculum
// pages and the stock-lab/research-engine/premium-guidance/legal-page fixes
// before it, just the last three pages left in that sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = ['forex-calendar.html', 'premarket.html', 'prop-firms.html'];

test('each page ships a #theme-toggle button', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(
      html,
      /<button id="theme-toggle" type="button">/,
      `${page} has no #theme-toggle button`,
    );
  }
});

// Pulls the self-contained wiring IIFE out of a page verbatim, the same
// "slice between two literal markers" approach the other theme-toggle test
// files use.
function extractWiringScript(html) {
  const marker = "var btn = document.getElementById('theme-toggle');";
  const markerAt = html.indexOf(marker);
  assert.notEqual(markerAt, -1, 'wiring script marker not found');
  const start = html.lastIndexOf('(function () {', markerAt);
  assert.notEqual(start, -1, 'wiring script IIFE opening not found');
  const end = html.indexOf('})();', markerAt);
  assert.notEqual(end, -1, 'wiring script end marker not found');
  return html.slice(start, end + '})();'.length);
}

function run(html, { storedTheme = null, bodyLight = false, storageThrows = false, vjmTurnstile = null } = {}) {
  const script = extractWiringScript(html);
  const store = new Map();
  if (storedTheme !== null) store.set('st-theme', storedTheme);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  };
  const bodyClasses = new Set();
  if (bodyLight) bodyClasses.add('light-mode');
  const listeners = [];
  const btn = {
    innerHTML: '',
    addEventListener: (_ev, fn) => listeners.push(fn),
    click: () => listeners.forEach((fn) => fn()),
  };
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'theme-toggle' ? btn : null),
      body: {
        classList: {
          toggle(c) { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); return bodyClasses.has(c); },
          contains: (c) => bodyClasses.has(c),
        },
      },
    },
    localStorage,
  };
  sandbox.window = sandbox;
  if (vjmTurnstile) sandbox.window.vjmTurnstile = vjmTurnstile;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { btn, store, bodyClasses };
}

for (const page of PAGES) {
  test(`${page}: theme toggle syncs its label to the page's current state on load`, () => {
    const html = read(page);
    const { btn: lightBtn } = run(html, { bodyLight: true });
    assert.match(lightBtn.innerHTML, /Light/);
    const { btn: darkBtn } = run(html, { bodyLight: false });
    assert.match(darkBtn.innerHTML, /Dark/);
  });

  test(`${page}: clicking the toggle flips light-mode and persists the explicit choice`, () => {
    const html = read(page);
    const { btn, store, bodyClasses } = run(html, { bodyLight: false });

    btn.click();
    assert.equal(bodyClasses.has('light-mode'), true, 'first click should turn light mode on');
    assert.equal(store.get('st-theme'), 'light');
    assert.match(btn.innerHTML, /Light/);

    btn.click();
    assert.equal(bodyClasses.has('light-mode'), false, 'second click should turn light mode back off');
    assert.equal(store.get('st-theme'), 'dark');
    assert.match(btn.innerHTML, /Dark/);
  });

  test(`${page}: a blocked localStorage does not stop the toggle from working`, () => {
    const html = read(page);
    const { btn, bodyClasses } = run(html, { bodyLight: false, storageThrows: true });
    assert.doesNotThrow(() => btn.click());
    assert.equal(bodyClasses.has('light-mode'), true);
    assert.match(btn.innerHTML, /Light/);
  });
}

// prop-firms.html is the only one of these three pages with a Turnstile-
// gated form (its own newsletter signup, mounted by assets/newsletter.js) --
// forex-calendar.html and premarket.html have no form that mounts a widget.
// Same gap the curriculum pages' lock-form widgets and index.html's
// newsletter/giveaway/quiz-lead forms had: the widget's theme is only ever
// set once, at render time, so flipping #theme-toggle after the widget
// rendered needs the identical remove-and-re-render nudge (assets/
// newsletter.js's resyncTurnstileTheme(), exposed as window.vjmTurnstile.
// resyncTheme).
test('prop-firms.html: clicking the toggle resyncs its newsletter form\'s Turnstile widget via window.vjmTurnstile.resyncTheme', () => {
  const html = read('prop-firms.html');
  const calls = [];
  const { btn } = run(html, { bodyLight: false, vjmTurnstile: { resyncTheme: (isLight) => calls.push(isLight) } });
  btn.click();
  assert.deepEqual(calls, [true], 'first click (dark -> light) should resync with isLight=true');
  btn.click();
  assert.deepEqual(calls, [true, false], 'second click should resync back with isLight=false');
});

test('prop-firms.html: clicking the toggle does not throw when assets/newsletter.js has not loaded (window.vjmTurnstile missing)', () => {
  const html = read('prop-firms.html');
  const { btn } = run(html, { bodyLight: false });
  assert.doesNotThrow(() => btn.click());
});

// forex-calendar.html is the one page of the three with its own hardcoded
// light-mode CSS (the other two ride assets/tokens.css's shared --vjm-*
// light-mode variables, which already redefine automatically). Pin that its
// #theme-toggle rule has a light-mode override, the same static-string check
// theme-toggle-legal-pages.test.mjs uses.
test('forex-calendar.html: the #theme-toggle CSS has a light-mode override', () => {
  const html = read('forex-calendar.html');
  assert.match(html, /body\.light-mode #theme-toggle\{/, 'no body.light-mode #theme-toggle override rule found');
});
