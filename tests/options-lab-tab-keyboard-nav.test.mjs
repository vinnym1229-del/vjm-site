// Incident: assets/curriculum.js's shared tab bars (level/group tabs, used
// by all four course pages) gained arrow-key/Home/End navigation with a
// roving tabindex in the prior run (tests/curriculum-tab-keyboard-nav.test.mjs),
// but that fix explicitly left options-lab.html's own two tab widgets alone
// -- #tabs (Options Basics/GEX/Full Curriculum) and #subtabs (GEX 101/Worked
// Scenarios/Where to Get Data/Translation) -- since they're driven by this
// page's own inline <script>, not assets/curriculum.js. They already carry
// role="tablist"/role="tab"/aria-selected (tests/regressions.test.mjs) but,
// like every tab widget before the curriculum.js fix, only ever handled
// clicks: no keydown listener, no tabIndex management.
//
// This drives the real wireTabKeyboardNav/activateTab/activateSubtab
// functions (extracted verbatim from the shipped inline script, not
// reimplemented) against a DOM stub shaped like the actual markup, and
// fires real keydown events -- proving the arrow-key path actually moves
// focus and activates the target tab/panel, not just that the markup
// carries the right attributes statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function extractInlineScript() {
  const html = read('options-lab.html');
  const start = html.indexOf('<script>\n// Both bars below');
  assert.ok(start > -1, 'could not find the options-lab.html tab-widget <script> block');
  const end = html.indexOf('function themeButtonHtml', start);
  assert.ok(end > start, 'could not find the end marker (function themeButtonHtml) after the tab-widget script');
  return html.slice(start + '<script>'.length, end);
}

// A DOM double covering exactly what this script touches: classList,
// dataset, tabIndex, focus()/activeElement, addEventListener,
// getElementById, and querySelectorAll with the two selector shapes used
// here (a bare class, and an id-scoped descendant class).
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

test('options-lab.html #tabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  const fx = makeFixture();
  run(fx);

  assert.equal(fx.tabs[0].tabIndex, 0, 'the initially-active tab must start at tabIndex 0');
  for (const t of fx.tabs.slice(1)) assert.equal(t.tabIndex, -1, 'inactive tabs must start at tabIndex -1');

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[1], 'ArrowRight must move focus to the next tab');
  assert.equal(fx.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(fx.tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(fx.tabs[1].tabIndex, 0, 'the newly-focused tab must become the roving tabIndex 0');
  assert.equal(fx.tabs[0].tabIndex, -1, 'the tab that lost focus must drop back to tabIndex -1');
  assert.equal(fx.tabPanels[1].classList.contains('active'), true, 'ArrowRight must switch to the target tab\'s panel');
  assert.equal(fx.tabPanels[0].classList.contains('active'), false);

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'ArrowLeft from the first tab must wrap to the last tab');

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'End must jump to the last tab');
  fx.tabsBar.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'Home must jump to the first tab');

  let prevented = false;
  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'a', preventDefault() { prevented = true; } });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'an unrelated key must not move focus');
  assert.equal(prevented, false, 'an unrelated key must not be preventDefault-ed');
});

test('options-lab.html #subtabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  const fx = makeFixture();
  run(fx);

  assert.equal(fx.subtabs[0].tabIndex, 0, 'the initially-active subtab must start at tabIndex 0');
  for (const t of fx.subtabs.slice(1)) assert.equal(t.tabIndex, -1, 'inactive subtabs must start at tabIndex -1');

  fx.focus(fx.subtabs[0]);
  fx.subtabsBar.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.subtabs[1], 'ArrowRight must move focus to the next subtab');
  assert.equal(fx.subtabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(fx.subtabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(fx.subpanels[1].classList.contains('active'), true, 'ArrowRight must switch to the target subtab\'s panel');
  assert.equal(fx.subpanels[0].classList.contains('active'), false);

  fx.focus(fx.subtabs[0]);
  fx.subtabsBar.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.subtabs[fx.subtabs.length - 1], 'End must jump to the last subtab');
  fx.subtabsBar.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.subtabs[0], 'Home must jump to the first subtab');
});
