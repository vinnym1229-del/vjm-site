// Incident: every role="tablist" widget on the site (curriculum.js's shared
// tabs, index.html's billing-period tabs, options-lab.html's own #tabs and
// #subtabs, research-engine.js's #moduleTabs) has now been given arrow-key/
// Home/End keyboard navigation with a roving tabindex -- stock-lab.html's
// premium sector-group switcher (#sectorTabs) was the last one left (see the
// 2026-09-20/21 entries in .opencode/decisions.md). It already carried
// role="tab"/aria-selected (tests/regressions.test.mjs), but only ever
// handled clicks.
//
// #sectorTabs is unlike every other tab bar this fix has touched: renderTabs()
// fully replaces the bar's innerHTML on every activation (GROUPS.map(...).join('')),
// rather than mutating a fixed set of persistent button nodes in place. That
// matters for keyboard nav specifically: wireTabKeyboardNav() calls
// tabs[to].focus() *before* invoking activate(), but activate() here calls
// setGroup() -> renderTabs(), which destroys the very button that was just
// focused (a fresh set of <button> nodes replaces it) -- in a real browser
// this drops focus to <body>, silently breaking every subsequent arrow-key
// press (document.activeElement is no longer one of the tabs, so the
// keydown handler's `from === -1` guard makes it a no-op). The fix re-selects
// and refocuses the newly-active tab after renderTabs() runs. This test
// exercises the real functions (extracted verbatim, not reimplemented)
// against a DOM stub whose innerHTML setter actually parses the rendered
// markup into focusable node stubs, so a regression that drops the refocus
// step -- or reintroduces the original bug -- shows up as focus getting lost
// after the first keypress, not just as a static markup/attribute check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function extractInlineFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${name} no longer defined in stock-lab.html`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name} from stock-lab.html`);
}

// Extracts everything from wireTabKeyboardNav's own definition through the
// wireTabKeyboardNav(...) call site that follows it (the whole call is a
// single statement ending in the next ');'), so the real wiring code runs
// exactly as shipped, not reimplemented here.
function extractWireCallSite(source) {
  const marker = 'function wireTabKeyboardNav(';
  const start = source.indexOf(marker);
  assert.ok(start > -1, 'wireTabKeyboardNav no longer defined in stock-lab.html');
  const callMarker = "wireTabKeyboardNav(el('sectorTabs'),";
  const callStart = source.indexOf(callMarker, start);
  assert.ok(callStart > -1, "wireTabKeyboardNav(el('sectorTabs'), ...) call site not found");
  const parenStart = source.indexOf('(', callStart);
  let depth = 0;
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) {
        assert.equal(source[i + 1], ';', 'expected call site to end with a semicolon');
        return source.slice(start, i + 2);
      }
    }
  }
  throw new Error('unbalanced parens extracting the wireTabKeyboardNav call site from stock-lab.html');
}

// A minimal DOM double: the container's innerHTML setter parses the
// rendered <button> markup into real focusable node stubs (getAttribute,
// dataset, classList, focus), matching how a browser replaces a subtree's
// children -- unlike tests/regressions.test.mjs's ARIA test, which only
// needs the raw HTML string.
function makeSectorTabsContainer() {
  let buttons = [];
  const container = {
    listeners: {},
    addEventListener(type, fn) { (container.listeners[type] ||= []).push(fn); },
    get innerHTML() { return container._html || ''; },
    set innerHTML(html) {
      container._html = html;
      buttons = [...html.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map((m) => {
        const attrs = {};
        for (const am of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[am[1]] = am[2];
        const classes = new Set((attrs.class || '').trim().split(/\s+/).filter(Boolean));
        const node = {
          tag: 'button',
          text: m[2],
          getAttribute: (k) => (k in attrs ? attrs[k] : null),
          setAttribute: (k, v) => { attrs[k] = String(v); },
          classList: { contains: (c) => classes.has(c) },
          dataset: { group: attrs['data-group'] },
          focus() { activeElement = node; },
        };
        return node;
      });
    },
    querySelectorAll(sel) {
      assert.equal(sel, '.tab', `unsupported selector in test stub: ${sel}`);
      return buttons;
    },
    querySelector(sel) {
      assert.equal(sel, '.tab.active', `unsupported selector in test stub: ${sel}`);
      return buttons.find((b) => b.classList.contains('active')) || null;
    },
  };
  return container;
}

let activeElement = null;

function run(groups, initialActive) {
  activeElement = null;
  const html = read('stock-lab.html');
  const tabIconSrc = extractInlineFunction(html, 'tabIcon');
  const renderTabsSrc = extractInlineFunction(html, 'renderTabs');
  const setGroupSrc = extractInlineFunction(html, 'setGroup');
  const wireSrc = extractWireCallSite(html);

  const sectorTabs = makeSectorTabsContainer();
  const sandbox = {
    GROUPS: groups,
    activeGroup: initialActive,
    document: {
      getElementById: (id) => { assert.equal(id, 'sectorTabs'); return sectorTabs; },
      get activeElement() { return activeElement; },
    },
    renderQuickSymbols() {},
    renderWatchlist() {},
    Array,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `const el = (id) => document.getElementById(id);\n${tabIconSrc}\n${renderTabsSrc}\n${setGroupSrc}\n${wireSrc}\nrenderTabs();`,
    sandbox
  );
  return { sandbox, sectorTabs, tabs: () => sectorTabs.querySelectorAll('.tab') };
}

test('stock-lab.html #sectorTabs renders a roving tabindex (0 on the active tab, -1 elsewhere)', () => {
  const { tabs } = run(['Best Rated', 'AI / Semis', 'Speculative'], 'AI / Semis');
  const btns = tabs();
  assert.equal(btns.length, 3);
  assert.equal(btns[0].getAttribute('tabindex'), '-1');
  assert.equal(btns[1].getAttribute('tabindex'), '0', 'the initially-active tab must be tabindex 0');
  assert.equal(btns[2].getAttribute('tabindex'), '-1');
});

test('stock-lab.html #sectorTabs ArrowRight moves focus, activates the target group, and keeps focus on the re-rendered tab', () => {
  const { sectorTabs, tabs } = run(['Best Rated', 'AI / Semis', 'Speculative'], 'Best Rated');
  const before = tabs();
  before[0].focus();
  assert.equal(activeElement, before[0]);

  sectorTabs.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });

  // renderTabs() replaced every button node; the pre-press references are stale.
  const after = tabs();
  assert.notEqual(activeElement, before[1], 'the stale pre-render node must not still be "focused"');
  assert.equal(activeElement, after[1], 'focus must land on the freshly-rendered AI / Semis button, not fall off the tab bar');
  assert.equal(after[1].getAttribute('aria-selected'), 'true');
  assert.equal(after[1].getAttribute('tabindex'), '0');
  assert.equal(after[0].getAttribute('aria-selected'), 'false');
  assert.equal(after[0].getAttribute('tabindex'), '-1');
});

test('stock-lab.html #sectorTabs keyboard nav survives two ArrowRight presses in a row', () => {
  // Regression guard for the exact failure mode this fix addresses: without
  // the post-render refocus, the second press finds document.activeElement
  // pointing at nothing in the tab list (from === -1) and silently no-ops.
  const { sectorTabs, tabs } = run(['Best Rated', 'AI / Semis', 'Speculative'], 'Best Rated');
  tabs()[0].focus();

  sectorTabs.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  sectorTabs.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });

  const after = tabs();
  assert.equal(activeElement, after[2], 'a second ArrowRight must move focus again, not silently no-op');
  assert.equal(after[2].getAttribute('aria-selected'), 'true');
  assert.equal(after[2].text.includes('Speculative'), true);
});

test('stock-lab.html #sectorTabs Home/End jump to the first/last tab and wrap on ArrowLeft', () => {
  const { sectorTabs, tabs } = run(['Best Rated', 'AI / Semis', 'Speculative'], 'AI / Semis');
  tabs()[1].focus();

  sectorTabs.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(activeElement, tabs()[2], 'End must jump to the last tab');

  sectorTabs.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(activeElement, tabs()[0], 'Home must jump to the first tab');

  sectorTabs.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(activeElement, tabs()[2], 'ArrowLeft from the first tab must wrap to the last tab');
});
