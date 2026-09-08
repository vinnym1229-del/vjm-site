// assets/theme.js and assets/curriculum.css ship a full default-light /
// explicit-dark theme system to all four curriculum pages (futures-dissection,
// options-lab, stock-breakdown, psychology-enhancer), but only options-lab.html
// ever had a #theme-toggle control to actually reach dark mode — the other
// three had the CSS and the bootstrap script with no way to trigger the class
// they support. Fixed by having curriculum.js (already shared by all four
// pages) wire up any #theme-toggle it finds, skipping one that already has
// its own onclick (options-lab.html's self-contained original) so it isn't
// bound twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const curriculum = read('assets/curriculum.js');

const CURRICULUM_PAGES = [
  'futures-dissection.html',
  'options-lab.html',
  'stock-breakdown.html',
  'psychology-enhancer.html',
];

test('every curriculum page ships a #theme-toggle button in its nav-cta', () => {
  for (const page of CURRICULUM_PAGES) {
    const html = read(page);
    assert.match(
      html,
      /<div class="nav-cta">\s*<button id="theme-toggle"/,
      `${page} has no #theme-toggle button in its nav-cta`,
    );
  }
});

// A DOM double just complete enough to run curriculum.js's real init() end to
// end (mirrors the stub tests/quiz-integrity.test.mjs already proves this
// against) plus a getElementById for the one element this feature touches.
function stubButton(attrs = {}) {
  const listeners = [];
  return {
    tagName: 'BUTTON',
    attrs: { ...attrs },
    innerHTML: '',
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(_ev, fn) { listeners.push(fn); },
    click() { listeners.forEach((fn) => fn()); },
    get boundListenerCount() { return listeners.length; },
  };
}

function run({ button, storageThrows } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const bodyClasses = new Set();
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({}) }),
    localStorage,
    location: { pathname: '/futures-dissection' },
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: (id) => (id === 'theme-toggle' ? button : null),
      body: {
        classList: {
          add: (c) => bodyClasses.add(c),
          remove: (c) => bodyClasses.delete(c),
          toggle(c) { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); return bodyClasses.has(c); },
          contains: (c) => bodyClasses.has(c),
        },
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);
  return { store, bodyClasses };
}

test('a #theme-toggle with no onclick gets wired up and toggles + persists the theme', async () => {
  const button = stubButton();
  const { store, bodyClasses } = run({ button });
  // init() is async; let its microtasks settle before asserting wiring.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(button.boundListenerCount, 1, 'the button should get exactly one click listener');

  button.click();
  assert.equal(bodyClasses.has('light-mode'), true, 'first click should turn light mode on');
  assert.equal(store.get('st-theme'), 'light');
  assert.match(button.innerHTML, /Light/);

  button.click();
  assert.equal(bodyClasses.has('light-mode'), false, 'second click should turn light mode back off');
  assert.equal(store.get('st-theme'), 'dark');
  assert.match(button.innerHTML, /Dark/);
});

test('a #theme-toggle that already has its own onclick (options-lab.html) is left alone', async () => {
  const button = stubButton({ onclick: 'toggleTheme()' });
  await new Promise((r) => setTimeout(r, 0));
  const { bodyClasses } = run({ button });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(button.boundListenerCount, 0, 'a button with its own onclick must not get a second listener bound');
  assert.equal(bodyClasses.has('light-mode'), false, 'init must not itself flip the theme as a side effect');
});

test('a page with no #theme-toggle at all does not throw during init', async () => {
  assert.doesNotThrow(() => run({ button: null }));
  await new Promise((r) => setTimeout(r, 0));
});
