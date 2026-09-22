// Incident: options-lab.html's #tabs/#subtabs got the WAI-ARIA Tabs
// pattern's keyboard half (tests/options-lab-tab-keyboard-nav.test.mjs) but
// not its pairing half -- a tab must name the panel it controls
// (aria-controls) and the panel must name the tab that owns it
// (role="tabpanel" + aria-labelledby). Without that pairing, a screen
// reader user who arrows onto "Gamma Exposure (GEX)" and activates it gets
// no programmatic signal that the GEX panel just became the visible
// content region. Same fix curriculum.js's wireTabPanelIds() and
// research-engine.js's wireModuleTabPanelIds() already applied elsewhere
// (tests/curriculum-tab-panel-aria.test.mjs, tests/research-engine-tab-panel-aria.test.mjs);
// options-lab.html carries its own copy since these two bars are driven by
// this page's own inline <script>, not a shared assets/*.js file.
//
// This drives the real wireTabPanelIds/activateTab/activateSubtab functions
// (extracted verbatim from the shipped inline script, not reimplemented)
// against a DOM stub shaped like the actual markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const clientHtml = read('options-lab.html');

function extractInlineScript() {
  const start = clientHtml.indexOf('<script>\n// Both bars below');
  assert.ok(start > -1, 'could not find the options-lab.html tab-widget <script> block');
  const end = clientHtml.indexOf('function themeButtonHtml', start);
  assert.ok(end > start, 'could not find the end marker (function themeButtonHtml) after the tab-widget script');
  return clientHtml.slice(start + '<script>'.length, end);
}

// A DOM double covering exactly what this script touches: classList,
// dataset, attrs (setAttribute/getAttribute), tabIndex, focus()/activeElement,
// addEventListener, getElementById, and querySelectorAll with the selector
// shapes used here (a bare class, and an id-scoped descendant class).
function makeNode(tag, { id, classes = [], dataset = {} } = {}) {
  const set = new Set(classes);
  const self = {
    tag, id, dataset, attrs: {}, tabIndex: 0, offsetTop: 0,
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
    addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
    focus() { activeElement = self; },
    closest(sel) {
      const m = /^\.([\w-]+)$/.exec(sel);
      let n = self;
      while (n) { if (m && n.classList?.contains(m[1])) return n; n = n.parent; }
      return null;
    },
    append(child) { child.parent = self; self.children.push(child); return child; },
    querySelectorAll(sel) { return queryFrom(self, sel); },
  };
  return self;
}

let activeElement = null;

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
  const scoped = /^#([\w-]+)\s+\.([\w-]+)$/.exec(sel);
  if (scoped) {
    const idEl = findById(root, scoped[1]);
    return idEl ? collectAll(idEl, (c) => c.classList.contains(scoped[2])) : [];
  }
  const bare = /^\.([\w-]+)$/.exec(sel);
  if (bare) return collectAll(root, (c) => c.classList.contains(bare[1]));
  throw new Error(`unsupported selector in test stub: ${sel}`);
}

function makeFixture() {
  activeElement = null;
  const root = makeNode('div');
  const tabsBar = root.append(makeNode('div', { id: 'tabs', classes: ['tabs'] }));
  const tabs = ['basics', 'gex', 'curriculum'].map((v, i) =>
    tabsBar.append(makeNode('button', { classes: ['tab-btn', ...(i === 0 ? ['active'] : [])], dataset: { tab: v } })));
  const panelBasics = root.append(makeNode('div', { id: 'panel-basics', classes: ['tab-panel', 'active'] }));
  const panelGex = root.append(makeNode('div', { id: 'panel-gex', classes: ['tab-panel'] }));
  const panelCurriculum = root.append(makeNode('div', { id: 'panel-curriculum', classes: ['tab-panel'] }));

  const subtabsBar = panelGex.append(makeNode('div', { id: 'subtabs', classes: ['subtabs'] }));
  const subtabs = ['gex101', 'scenarios', 'data', 'translate'].map((v, i) =>
    subtabsBar.append(makeNode('button', { classes: ['subtab-btn', ...(i === 0 ? ['active'] : [])], dataset: { subtab: v } })));
  const subpanels = ['gex101', 'scenarios', 'data', 'translate'].map((v, i) =>
    panelGex.append(makeNode('div', { id: `subpanel-${v}`, classes: ['sub-panel', ...(i === 0 ? ['active'] : [])] })));

  const document = {
    get activeElement() { return activeElement; },
    getElementById: (id) => findById(root, id),
    querySelectorAll: (sel) => queryFrom(root, sel),
  };
  const window = { scrollTo() {} };
  return {
    document, window,
    tabs, tabPanels: [panelBasics, panelGex, panelCurriculum],
    tabsBar, subtabsBar, subtabs, subpanels,
    focus: (n) => { activeElement = n; },
  };
}

function run(fixture) {
  const sandbox = { document: fixture.document, window: fixture.window, console, Array };
  vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(), sandbox);
  return sandbox;
}

test('options-lab.html markup has no static aria-controls/tabpanel pairing (JS must add it)', () => {
  assert.doesNotMatch(clientHtml, /class="tab-btn[^"]*"[^>]*aria-controls/, 'if this starts passing, this test and the JS-side fix are both redundant');
  assert.doesNotMatch(clientHtml, /class="subtab-btn[^"]*"[^>]*aria-controls/);
  assert.doesNotMatch(clientHtml, /id="panel-[a-z]+"[^>]*role="tabpanel"/);
  assert.doesNotMatch(clientHtml, /id="subpanel-[a-z]+"[^>]*role="tabpanel"/);
});

test('#tabs: every tab gets an aria-controls pointing at a real, matching role="tabpanel"', () => {
  const fx = makeFixture();
  run(fx);
  fx.tabs.forEach((tab, i) => {
    const panel = fx.tabPanels[i];
    assert.ok(tab.id, 'tab must get an id');
    assert.equal(tab.getAttribute('aria-controls'), panel.id, 'tab aria-controls must name its own panel\'s id');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id, 'panel aria-labelledby must name its own tab\'s id');
  });
});

test('#subtabs: every subtab gets an aria-controls pointing at a real, matching role="tabpanel"', () => {
  const fx = makeFixture();
  run(fx);
  fx.subtabs.forEach((tab, i) => {
    const panel = fx.subpanels[i];
    assert.ok(tab.id, 'subtab must get an id');
    assert.equal(tab.getAttribute('aria-controls'), panel.id, 'subtab aria-controls must name its own panel\'s id');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id, 'panel aria-labelledby must name its own subtab\'s id');
  });
});

test('wireTabPanelIds keeps each already-stable panel id rather than minting a new one', () => {
  const fx = makeFixture();
  run(fx);
  assert.equal(fx.tabPanels[0].id, 'panel-basics');
  assert.equal(fx.tabPanels[1].id, 'panel-gex');
  assert.equal(fx.subpanels[0].id, 'subpanel-gex101');
});

test('every tab/subtab aria-controls resolves to a panel actually reachable in the DOM (not a dangling id)', () => {
  const fx = makeFixture();
  run(fx);
  const byId = new Map([...fx.tabPanels, ...fx.subpanels].map((p) => [p.id, p]));
  [...fx.tabs, ...fx.subtabs].forEach((tab) => {
    const targetId = tab.getAttribute('aria-controls');
    assert.ok(byId.has(targetId), `aria-controls="${targetId}" must resolve to a real panel`);
  });
});
