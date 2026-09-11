// board.md row 3's last open question: 404.html and unsubscribe.html were the
// two pages excluded from every prior theme-toggle sweep (curriculum, legal,
// tools, markets) for having no nav at all. Evaluated both: 404.html is a
// transient exit page a visitor bounces off in one of four clicks, not worth
// a control for. unsubscribe.html is different -- a real destination someone
// can land on directly from an email link, having never visited the main
// site, already ships assets/theme.js's default-light bootstrap and rides
// assets/tokens.css's shared --vjm-* light-mode variables (so, like
// premarket.html/prop-firms.html, no separate light-mode override rule is
// needed), but had no way back to dark once there. Same fix, same
// self-contained wiring script, copied verbatim from theme-toggle-markets.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const html = read('unsubscribe.html');

test('unsubscribe.html ships a #theme-toggle button', () => {
  assert.match(
    html,
    /<button id="theme-toggle" type="button">/,
    'unsubscribe.html has no #theme-toggle button',
  );
});

// Pulls the self-contained wiring IIFE out of the page verbatim, the same
// "slice between two literal markers" approach the other theme-toggle test
// files use.
function extractWiringScript(source) {
  const marker = "var btn = document.getElementById('theme-toggle');";
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, 'wiring script marker not found');
  const start = source.lastIndexOf('(function () {', markerAt);
  assert.notEqual(start, -1, 'wiring script IIFE opening not found');
  const end = source.indexOf('})();', markerAt);
  assert.notEqual(end, -1, 'wiring script end marker not found');
  return source.slice(start, end + '})();'.length);
}

function run(source, { storedTheme = null, bodyLight = false, storageThrows = false } = {}) {
  const script = extractWiringScript(source);
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

test("unsubscribe.html: theme toggle syncs its label to the page's current state on load", () => {
  const { btn: lightBtn } = run(html, { bodyLight: true });
  assert.match(lightBtn.innerHTML, /Light/);
  const { btn: darkBtn } = run(html, { bodyLight: false });
  assert.match(darkBtn.innerHTML, /Dark/);
});

test('unsubscribe.html: clicking the toggle flips light-mode and persists the explicit choice', () => {
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

test('unsubscribe.html: a blocked localStorage does not stop the toggle from working', () => {
  const { btn, bodyClasses } = run(html, { bodyLight: false, storageThrows: true });
  assert.doesNotThrow(() => btn.click());
  assert.equal(bodyClasses.has('light-mode'), true);
  assert.match(btn.innerHTML, /Light/);
});

test('unsubscribe.html: the toggle rides tokens.css shared variables, no separate light-mode override needed', () => {
  assert.match(html, /#theme-toggle\{[^}]*var\(--vjm-muted\)/, 'expected #theme-toggle to use the shared --vjm-muted token');
  assert.doesNotMatch(html, /body\.light-mode #theme-toggle\{/, 'unsubscribe.html should not need its own light-mode override (tokens.css redefines --vjm-* already)');
});
