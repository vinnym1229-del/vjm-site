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

function run({ button, storageThrows, turnstileWidget = null, turnstileLoaded = true } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const bodyClasses = new Set();
  const turnstileCalls = { removed: [], rendered: [] };
  const turnstile = {
    remove: (el) => turnstileCalls.removed.push(el),
    render: (el, params) => turnstileCalls.rendered.push({ el, params }),
  };
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({}) }),
    localStorage,
    location: { pathname: '/futures-dissection' },
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: () => ({ setAttribute() {}, classList: { add() {} } }),
      querySelectorAll: (sel) => (sel === '.cf-turnstile' && turnstileWidget ? [turnstileWidget] : []),
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
  if (turnstileLoaded) sandbox.turnstile = turnstile;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);
  return { store, bodyClasses, turnstileCalls };
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

// Incident: the four curriculum pages' per-level lock-form Turnstile widgets
// (injectTurnstileWidgets()) only had data-theme set once, at creation time.
// Cloudflare bakes the theme into the rendered iframe once and has no
// live-restyle hook, so flipping #theme-toggle after a widget had already
// rendered left it frozen in the old theme -- a member mid-unlock on any
// gated level who toggled theme saw a mismatched CAPTCHA box next to the
// now-recolored panel around it. initThemeToggle()'s click handler must
// call the shared resyncTurnstileTheme() (also used by options-lab.html's
// own self-contained toggleTheme(), the one page skipped above) to remove
// and re-render every .cf-turnstile widget in the new theme.
test('a #theme-toggle click re-renders an already-rendered Turnstile widget in the new theme', async () => {
  const button = stubButton();
  const widget = { dataset: { theme: 'dark', sitekey: 'test-sitekey' } };
  const { bodyClasses, turnstileCalls } = run({ button, turnstileWidget: widget });
  await new Promise((r) => setTimeout(r, 0));

  button.click(); // dark -> light
  assert.equal(bodyClasses.has('light-mode'), true);
  assert.equal(widget.dataset.theme, 'light', 'widget dataset.theme should flip to light');
  assert.equal(turnstileCalls.removed.length, 1, 'turnstile.remove should be called once');
  assert.equal(turnstileCalls.removed[0], widget);
  assert.equal(turnstileCalls.rendered.length, 1, 'turnstile.render should be called once');
  assert.equal(turnstileCalls.rendered[0].params.theme, 'light');
  assert.equal(turnstileCalls.rendered[0].params.sitekey, 'test-sitekey');

  button.click(); // light -> dark
  assert.equal(widget.dataset.theme, 'dark', 'widget dataset.theme should flip back to dark');
  assert.equal(turnstileCalls.removed.length, 2);
  assert.equal(turnstileCalls.rendered.length, 2);
  assert.equal(turnstileCalls.rendered[1].params.theme, 'dark');
});

test('a #theme-toggle click before Turnstile has loaded still updates data-theme without throwing', async () => {
  const button = stubButton();
  const widget = { dataset: { theme: 'dark', sitekey: 'test-sitekey' } };
  const { bodyClasses } = run({ button, turnstileWidget: widget, turnstileLoaded: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.doesNotThrow(() => button.click());
  assert.equal(bodyClasses.has('light-mode'), true);
  assert.equal(widget.dataset.theme, 'light');
});

test('a #theme-toggle that already has its own onclick (options-lab.html) is left alone', async () => {
  const button = stubButton({ onclick: 'toggleTheme()' });
  await new Promise((r) => setTimeout(r, 0));
  const { bodyClasses } = run({ button });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(button.boundListenerCount, 0, 'a button with its own onclick must not get a second listener bound');
  assert.equal(bodyClasses.has('light-mode'), false, 'init must not itself flip the theme as a side effect');
});

// options-lab.html owns its own toggle (the one skipped above) and so needs
// its own call to the shared Turnstile re-theme fix rather than getting it
// through initThemeToggle() -- same incident as the tests above, just the
// one page whose click handler lives in its own markup instead of
// curriculum.js. Runs the real function from the file (not a re-typed copy)
// so a future edit to either side of the call can't silently drift apart.
test("options-lab.html's own toggleTheme() calls the shared Turnstile re-theme fix", () => {
  const html = read('options-lab.html');
  const fnMatch = html.match(/function toggleTheme\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'toggleTheme() not found in options-lab.html');

  const turnstileCalls = { removed: [], rendered: [] };
  const widget = { dataset: { theme: 'dark', sitekey: 'test-sitekey' } };
  const bodyClasses = new Set();
  const btn = { innerHTML: '' };
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'theme-toggle' ? btn : null),
      body: { classList: { toggle: (c) => { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); return bodyClasses.has(c); } } },
    },
    localStorage: { setItem() {} },
    themeButtonHtml: () => '',
  };
  sandbox.window = sandbox;
  sandbox.window.vjmResyncTurnstileTheme = (isLight) => {
    widget.dataset.theme = isLight ? 'light' : 'dark';
    turnstileCalls.removed.push(widget);
    turnstileCalls.rendered.push({ theme: isLight ? 'light' : 'dark' });
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnMatch[0]}\ntoggleTheme();`, sandbox);

  assert.equal(bodyClasses.has('light-mode'), true, 'toggleTheme should still flip light-mode itself');
  assert.equal(turnstileCalls.removed.length, 1, 'toggleTheme should call window.vjmResyncTurnstileTheme');
  assert.equal(widget.dataset.theme, 'light');
});

test('a page with no #theme-toggle at all does not throw during init', async () => {
  assert.doesNotThrow(() => run({ button: null }));
  await new Promise((r) => setTimeout(r, 0));
});
