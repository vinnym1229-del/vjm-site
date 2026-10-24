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

function run(html, { storedTheme = null, bodyLight = false, storageThrows = false, turnstileLoaded = true } = {}) {
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
  // A single already-rendered Turnstile widget, the same shape the real
  // #pg-ts/#re-ts/#stocklab-ts div has: a data-sitekey and a data-theme the
  // page-load-time fix already set. remove()/render() calls are recorded so
  // the toggle test below can prove the click handler actually re-themes it,
  // not just that it doesn't throw.
  const widget = { dataset: { theme: 'dark', sitekey: 'test-sitekey' } };
  const turnstileCalls = { removed: [], rendered: [] };
  const turnstile = {
    remove: (el) => turnstileCalls.removed.push(el),
    render: (el, params) => turnstileCalls.rendered.push({ el, params }),
  };
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'theme-toggle' ? btn : null),
      querySelectorAll: (sel) => (sel === '.cf-turnstile' ? [widget] : []),
      body: {
        classList: {
          toggle(c) { bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c); return bodyClasses.has(c); },
          contains: (c) => bodyClasses.has(c),
        },
      },
    },
    localStorage,
    window: { turnstile: turnstileLoaded ? turnstile : undefined },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { btn, store, bodyClasses, widget, turnstileCalls };
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

  // Incident: Turnstile bakes its theme into the rendered iframe once and has
  // no live-restyle hook, so a widget that was already on screen (the
  // member unlock gate below the field this toggle lives next to) stayed
  // frozen in the old theme after a toggle click -- a visitor who flips to
  // dark mid-unlock saw a stark white CAPTCHA box stuck in the newly dark
  // sign-in card. The click handler must remove and re-render it with the
  // theme that just became active, not just flip body.light-mode.
  test(`${page}: clicking the toggle re-renders an already-rendered Turnstile widget in the new theme`, () => {
    const html = read(page);
    const { btn, widget, turnstileCalls } = run(html, { bodyLight: false });

    btn.click(); // dark -> light
    assert.equal(widget.dataset.theme, 'light', 'widget dataset.theme should flip to light');
    assert.equal(turnstileCalls.removed.length, 1, 'turnstile.remove should be called once');
    assert.equal(turnstileCalls.removed[0], widget);
    assert.equal(turnstileCalls.rendered.length, 1, 'turnstile.render should be called once');
    assert.equal(turnstileCalls.rendered[0].el, widget);
    assert.equal(turnstileCalls.rendered[0].params.theme, 'light');
    assert.equal(turnstileCalls.rendered[0].params.sitekey, 'test-sitekey');

    btn.click(); // light -> dark
    assert.equal(widget.dataset.theme, 'dark', 'widget dataset.theme should flip back to dark');
    assert.equal(turnstileCalls.removed.length, 2);
    assert.equal(turnstileCalls.rendered.length, 2);
    assert.equal(turnstileCalls.rendered[1].params.theme, 'dark');
  });

  // Turnstile's script tag is async/defer; a fast click before it has loaded
  // must not throw, and must still leave data-theme correct so the widget
  // auto-renders in the right theme once Turnstile does load.
  test(`${page}: clicking the toggle before Turnstile has loaded still updates data-theme without throwing`, () => {
    const html = read(page);
    const { btn, widget } = run(html, { bodyLight: false, turnstileLoaded: false });
    assert.doesNotThrow(() => btn.click());
    assert.equal(widget.dataset.theme, 'light');
  });

  test(`${page}: a blocked localStorage does not stop the toggle from working`, () => {
    const html = read(page);
    const { btn, bodyClasses } = run(html, { bodyLight: false, storageThrows: true });
    assert.doesNotThrow(() => btn.click());
    assert.equal(bodyClasses.has('light-mode'), true);
    assert.match(btn.innerHTML, /Light/);
  });
}
