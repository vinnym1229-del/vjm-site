// Incident: research-engine.html's #moduleTabs got the WAI-ARIA Tabs
// pattern's keyboard half (tests/research-engine-tab-keyboard-nav.test.mjs)
// but not its pairing half -- a tab must name the panel it controls
// (aria-controls) and the panel must name the tab that owns it
// (role="tabpanel" + aria-labelledby). Without that pairing, a screen
// reader user who arrows onto "Stocks" and activates it gets no
// programmatic signal that the Stock Swing Lab panel just became the
// visible content region. Same fix curriculum.js's wireTabPanelIds()
// already applied to the four paid course pages
// (tests/curriculum-tab-panel-aria.test.mjs); assets/research-engine.js
// carries its own copy (wireModuleTabPanelIds) since this file isn't
// shared with those pages.
//
// This runs the REAL assets/research-engine.js through vm against a DOM
// stub built around the actual #moduleTabs/[data-module-panel] markup and
// lets its own `document.addEventListener('DOMContentLoaded', wire)` fire
// wire() the way a real page load does, proving wireModuleTabPanelIds()
// actually wires the pairing on init, not just that the function exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientJs = readFileSync(resolve(projectRoot, 'assets/research-engine.js'), 'utf8');
const clientHtml = readFileSync(resolve(projectRoot, 'research-engine.html'), 'utf8');

function makeNode(tag, { id = '', classes = [], dataset = {} } = {}) {
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
    focus() {},
    closest() { return null; },
    querySelector(sel) { return queryFrom(self, sel)[0] || null; },
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
// Supports the two selector shapes wireModuleTabPanelIds actually uses:
// a bare class (".module-tab") and a data-attribute-with-value
// ("[data-module-panel=\"stocks\"]").
function queryFrom(root, sel) {
  sel = sel.trim();
  const bare = /^\.([\w-]+)$/.exec(sel);
  if (bare) return collectAll(root, (c) => c.classList.contains(bare[1]));
  const attrValue = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (attrValue) {
    const key = attrValue[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return collectAll(root, (c) => c.dataset[key] === attrValue[2]);
  }
  throw new Error(`unsupported selector in test stub: ${sel}`);
}

function makeFixture() {
  const root = makeNode('div');
  const moduleTabsBar = root.append(makeNode('div', { id: 'moduleTabs', classes: ['module-nav'] }));
  const modules = ['options', 'stocks', 'sectors', 'biotech'];
  const tabs = modules.map((m, i) =>
    moduleTabsBar.append(makeNode('button', { classes: ['module-tab', ...(i === 0 ? ['active'] : [])], dataset: { module: m } })));
  const panels = modules.map((m, i) =>
    root.append(makeNode('article', { id: `module-${m}`, classes: ['module', ...(i === 0 ? ['active'] : [])], dataset: { modulePanel: m } })));

  const elCache = new Map();
  const fallbackEl = (id) => {
    if (!elCache.has(id)) elCache.set(id, makeNode('div', { id }));
    return elCache.get(id);
  };

  const document = {
    getElementById: (id) => findById(root, id) || fallbackEl(id),
    querySelector: (sel) => queryFrom(root, sel)[0] || null,
    querySelectorAll: (sel) => queryFrom(root, sel),
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') fn(); },
    body: makeNode('div', { id: '__body' }),
  };
  return { document, moduleTabsBar, tabs, panels };
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

test('research-engine.html markup has no static aria-controls/tabpanel pairing (JS must add it)', () => {
  assert.doesNotMatch(clientHtml, /class="module-tab"[^>]*aria-controls/, 'if this starts passing, this test and the JS-side fix are both redundant');
  assert.doesNotMatch(clientHtml, /data-module-panel="[a-z]+"[^>]*role="tabpanel"/);
});

test('wire() gives every #moduleTabs tab an aria-controls pointing at a real, matching role="tabpanel"', () => {
  const fx = makeFixture();
  run(fx);
  fx.tabs.forEach((tab, i) => {
    const panel = fx.panels[i];
    assert.ok(tab.id, 'tab must get an id');
    assert.equal(tab.getAttribute('aria-controls'), panel.id, 'tab aria-controls must name its own panel\'s id');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id, 'panel aria-labelledby must name its own tab\'s id');
  });
});

test('wireModuleTabPanelIds keeps each already-stable panel id rather than minting a new one', () => {
  const fx = makeFixture();
  const sandbox = run(fx);
  fx.panels.forEach((panel, i) => assert.equal(panel.id, `module-${['options', 'stocks', 'sectors', 'biotech'][i]}`));
  // Idempotent: calling it again (e.g. a second wire()) must not change ids or drop attributes.
  sandbox.window.__researchEngineInternals.wireModuleTabPanelIds();
  fx.tabs.forEach((tab, i) => assert.equal(tab.getAttribute('aria-controls'), fx.panels[i].id));
});

test('every tab\'s aria-controls resolves to a panel actually reachable in the DOM (not a dangling id)', () => {
  const fx = makeFixture();
  run(fx);
  const byId = new Map(fx.panels.map((p) => [p.id, p]));
  fx.tabs.forEach((tab) => {
    const targetId = tab.getAttribute('aria-controls');
    assert.ok(byId.has(targetId), `aria-controls="${targetId}" must resolve to a real panel`);
  });
});
