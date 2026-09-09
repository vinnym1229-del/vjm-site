// The three member tool/sign-in pages (stock-lab, research-engine,
// premium-guidance) all ship assets/theme.js's default-light bootstrap and a
// full light-mode CSS block, the same as every curriculum page, but never got
// a #theme-toggle control -- a visitor could land in light mode and had no
// way back to dark. None of the three load curriculum.js (it also renders
// curriculum-specific quiz/lock-gate markup that has no business here), so
// each got its own small self-contained wiring script instead of relying on
// curriculum.js's shared initThemeToggle().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = ['stock-lab.html', 'research-engine.html', 'premium-guidance.html'];

test('each tool/sign-in page ships a #theme-toggle button', () => {
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
// "slice between two literal markers" approach tests/theme-toggle-index-default
// uses for index.html's block.
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

function run(html, { storedTheme = null, bodyLight = false, storageThrows = false } = {}) {
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
