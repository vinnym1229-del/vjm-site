// Incident: every role="tablist" widget on the site (curriculum.js's shared
// tabs, index.html's billing-period tabs, options-lab.html's own #tabs/
// #subtabs, stock-lab's #sectorTabs) has been getting arrow-key/Home/End
// keyboard navigation added one page at a time, but research-engine.html's
// #moduleTabs (Options/Stocks/Sectors/Biotech) was still click-only: role="tab"
// makes a screen reader announce "tab, 1 of 4" and expect the arrow keys to
// move between tabs, and Tab was the only way off the group.
//
// This runs the REAL assets/research-engine.js through vm (not a
// reimplementation) against a DOM stub built around the actual #moduleTabs
// markup, lets its own `document.addEventListener('DOMContentLoaded', wire)`
// fire wire() the way a real page load does, and fires real keydown events --
// proving setModule()'s roving tabIndex and wireTabKeyboardNav's registration
// on #moduleTabs both actually work together, not just that the markup
// carries the right attributes statically (tests/regressions.test.mjs already
// covers that part).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientJs = readFileSync(resolve(projectRoot, 'assets/research-engine.js'), 'utf8');

let activeElement = null;

function makeNode(tag, { id, classes = [], dataset = {} } = {}) {
  const set = new Set(classes);
  const self = {
    tag, id, dataset, attrs: {}, tabIndex: 0,
    value: '', disabled: false, hidden: false, style: {}, textContent: '', innerHTML: '', className: '',
    children: [], parent: null, listeners: {},
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle(c, force) {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        return on;
      },
    },
    setAttribute(k, v) { self.attrs[k] = String(v); },
    getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
    removeAttribute(k) { delete self.attrs[k]; },
    addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
    focus() { activeElement = self; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll(sel) { return queryFrom(self, sel); },
    append(child) { child.parent = self; self.children.push(child); return child; },
    appendChild(child) { return self.append(child); },
    scrollIntoView() {},
  };
  return self;
}

function collectAll(root, pred, out = []) {
  root.children.forEach((c) => { if (pred(c)) out.push(c); collectAll(c, pred, out); });
  return out;
}
function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) { const f = findById(c, id); if (f) return f; }
  return null;
}
function queryFrom(root, sel) {
  sel = sel.trim();
  const bare = /^\.([\w-]+)$/.exec(sel);
  if (bare) return collectAll(root, (c) => c.classList.contains(bare[1]));
  const attr = /^\[data-([\w-]+)\]$/.exec(sel);
  if (attr) {
    const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return collectAll(root, (c) => key in c.dataset);
  }
  const attrValue = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (attrValue) {
    const key = attrValue[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return collectAll(root, (c) => c.dataset[key] === attrValue[2]);
  }
  throw new Error(`unsupported selector in test stub: ${sel}`);
}

function makeFixture() {
  activeElement = null;
  const root = makeNode('div');
  const moduleTabsBar = root.append(makeNode('div', { id: 'moduleTabs', classes: ['module-nav'] }));
  const modules = ['options', 'stocks', 'sectors', 'biotech'];
  const tabs = modules.map((m, i) =>
    moduleTabsBar.append(makeNode('button', { classes: ['module-tab', ...(i === 0 ? ['active'] : [])], dataset: { module: m } })));
  tabs.forEach((t, i) => { t.tabIndex = i === 0 ? 0 : -1; t.attrs['aria-selected'] = String(i === 0); });
  const panels = modules.map((m, i) =>
    root.append(makeNode('article', { classes: ['module', ...(i === 0 ? ['active'] : [])], dataset: { modulePanel: m } })));

  const elCache = new Map();
  const fallbackEl = (id) => {
    if (!elCache.has(id)) elCache.set(id, makeNode('div', { id }));
    return elCache.get(id);
  };

  const document = {
    get activeElement() { return activeElement; },
    getElementById: (id) => findById(root, id) || fallbackEl(id),
    querySelector: (sel) => queryFrom(root, sel)[0] || null,
    querySelectorAll: (sel) => queryFrom(root, sel),
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') fn(); },
    body: makeNode('div', { id: '__body' }),
  };
  return { document, moduleTabsBar, tabs, panels, focus: (n) => { activeElement = n; } };
}

function run(fixture) {
  const sandbox = {
    console,
    document: fixture.document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: async () => { throw new Error('simulated network failure'); },
    requestAnimationFrame() {},
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    Blob: function () {},
    alert() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(clientJs, sandbox, { filename: 'research-engine.sandboxed.js' });
  return sandbox;
}

test('research-engine.html #moduleTabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  const fx = makeFixture();
  run(fx);

  assert.equal(fx.moduleTabsBar.listeners.keydown?.length, 1, 'wire() must register exactly one keydown listener on #moduleTabs');

  fx.focus(fx.tabs[0]);
  fx.moduleTabsBar.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[1], 'ArrowRight must move focus to the next tab');
  assert.equal(fx.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(fx.tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(fx.tabs[1].tabIndex, 0, 'the newly-activated tab must become the roving tabIndex 0');
  assert.equal(fx.tabs[0].tabIndex, -1, 'the tab that lost activation must drop back to tabIndex -1');
  assert.equal(fx.panels[1].classList.contains('active'), true, 'ArrowRight must switch to the target module\'s panel');
  assert.equal(fx.panels[0].classList.contains('active'), false);

  fx.focus(fx.tabs[0]);
  fx.moduleTabsBar.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'ArrowLeft from the first tab must wrap to the last tab');

  fx.focus(fx.tabs[0]);
  fx.moduleTabsBar.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'End must jump to the last tab');
  fx.moduleTabsBar.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'Home must jump to the first tab');

  let prevented = false;
  fx.focus(fx.tabs[0]);
  fx.moduleTabsBar.listeners.keydown[0]({ key: 'a', preventDefault() { prevented = true; } });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'an unrelated key must not move focus');
  assert.equal(prevented, false, 'an unrelated key must not be preventDefault-ed');
});

test('research-engine.html #moduleTabs starts with a single roving tabindex before any interaction', () => {
  const fx = makeFixture();
  run(fx);
  assert.equal(fx.tabs[0].tabIndex, 0, 'the initially-active tab must start at tabIndex 0');
  for (const t of fx.tabs.slice(1)) assert.equal(t.tabIndex, -1, 'inactive tabs must start at tabIndex -1');
});
