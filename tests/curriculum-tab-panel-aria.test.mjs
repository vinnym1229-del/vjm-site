// Incident: assets/curriculum.js's tab bars (role="tablist"/role="tab") got
// full arrow-key/Home/End keyboard navigation in an earlier run
// (tests/curriculum-tab-keyboard-nav.test.mjs), but the WAI-ARIA Tabs
// pattern has a second, separate requirement that fix never touched: each
// tab must name the panel it controls (aria-controls) and each panel must
// name the tab that owns it (role="tabpanel" + aria-labelledby). Without
// that pairing, a screen-reader user who arrows onto a tab and activates it
// gets no programmatic signal that a specific content region just became
// visible -- the relationship the pattern exists to expose was simply
// absent, on every tab widget curriculum.js drives (all four paid course
// pages' level tabs, plus psychology-enhancer.html's group tabs).
//
// This drives the real wireTabPanelIds()/initGroupTabs()/initLevelTabs()
// functions (extracted from the shipped source, not reimplemented) against
// a DOM stub built around the actual data-pair/data-group + value-attribute
// markup shape, including two independent tab groups on one page (mirroring
// psychology-enhancer.html's A/B/C/D group and a course page's four-level
// bar coexisting), to prove ids stay unique and correctly paired rather than
// colliding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Same brace-walking extractor tests/nav-dropdown-focus.test.mjs uses: these
// function bodies don't nest evenly enough for a bounded regex.
function extractBlock(source, startNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start > -1, `could not find ${JSON.stringify(startNeedle)} in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

// A minimal DOM double supporting a class plus zero or more chained
// [data-x="y"] attribute filters (curriculum.js's panel lookups chain a
// pair/group filter with a value filter, e.g. `.level-panel[data-pair="p"]`
// combined with `[data-level="2"]`), and both querySelector (first match)
// and querySelectorAll, matching what wireTabPanelIds and the two init
// functions actually call.
function node(tag, classes = [], dataset = {}) {
  const set = new Set(classes);
  const self = {
    tag,
    dataset,
    id: '',
    attrs: {},
    listeners: {},
    tabIndex: 0,
    children: [],
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
      },
    },
    setAttribute(k, v) { self.attrs[k] = String(v); },
    getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
    addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
    focus() {},
    append(child) { child.parent = self; self.children.push(child); return child; },
    querySelectorAll(sel) { return findAll(self, sel); },
    querySelector(sel) { return findAll(self, sel)[0] || null; },
  };
  return self;
}

function selectorMatches(n, sel) {
  const m = /^\.([\w-]+)((?:\[data-[\w-]+="[^"]*"\])*)$/.exec(sel.trim());
  assert.ok(m, `unsupported selector in test stub: ${sel}`);
  const [, cls, attrsStr] = m;
  if (!n.classList.contains(cls)) return false;
  const attrRe = /\[data-([\w-]+)="([^"]*)"\]/g;
  let am;
  while ((am = attrRe.exec(attrsStr))) {
    const key = am[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (n.dataset[key] !== am[2]) return false;
  }
  return true;
}

function findAll(root, sel) {
  const out = [];
  (function walk(n) {
    n.children.forEach((c) => {
      if (selectorMatches(c, sel)) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

// Builds a page with two independent tab widgets: a psychology-enhancer-
// style group-tabs bar (group="psych-enhancer", values A-D) and a course-
// page-style level-tabs bar (pair="futures", levels 1-4) -- the same two
// widget shapes real pages coexist with, so a same-page id collision would
// show up here.
function makePageStub() {
  const root = node('div', []);

  const groupBar = root.append(node('div', ['group-tabs'], { group: 'psych-enhancer' }));
  const groupValues = ['A', 'B', 'C', 'D'];
  const groupTabs = groupValues.map((v, i) =>
    groupBar.append(node('button', ['group-tab', ...(i === 0 ? ['active'] : [])], { groupValue: v }))
  );
  const groupPanels = groupValues.map((v, i) =>
    root.append(node('div', ['group-panel', ...(i === 0 ? ['active'] : [])], { group: 'psych-enhancer', groupValue: v }))
  );

  const levelBar = root.append(node('div', ['level-tabs'], { pair: 'futures' }));
  const levelValues = ['1', '2', '3', '4'];
  const levelTabs = levelValues.map((v, i) =>
    levelBar.append(node('button', ['level-tab', ...(i === 0 ? ['active'] : [])], { level: v, pair: 'futures' }))
  );
  const levelPanels = levelValues.map((v, i) =>
    root.append(node('section', ['level-panel', ...(i === 0 ? ['active'] : [])], { level: v, pair: 'futures' }))
  );

  const document = {
    querySelectorAll: (sel) => findAll(root, sel),
    querySelector: (sel) => findAll(root, sel)[0] || null,
  };
  return { document, groupBar, groupTabs, groupPanels, levelBar, levelTabs, levelPanels };
}

function runInit() {
  const src = read('assets/curriculum.js');
  const snippet = [
    extractBlock(src, 'function wireTabKeyboardNav(bar, tabSelector, activate)'),
    extractBlock(src, 'function wireTabPanelIds(tabs, valueAttr, panelSelectorBase, panelValueAttr, idPrefix)'),
    extractBlock(src, 'function initGroupTabs()'),
    extractBlock(src, 'function initLevelTabs()'),
    'initGroupTabs();',
    'initLevelTabs();',
  ].join('\n');
  const stub = makePageStub();
  const sandbox = { document: stub.document, console };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  return stub;
}

test('every group-tab gets aria-controls pointing at a real, matching role="tabpanel"', () => {
  const { groupTabs, groupPanels } = runInit();
  groupTabs.forEach((tab, i) => {
    const panel = groupPanels[i];
    assert.ok(tab.id, 'tab must get an id');
    assert.ok(panel.id, 'panel must get an id');
    assert.equal(tab.getAttribute('aria-controls'), panel.id, 'tab aria-controls must name its own panel\'s id');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id, 'panel aria-labelledby must name its own tab\'s id');
  });
});

test('every level-tab gets aria-controls pointing at a real, matching role="tabpanel"', () => {
  const { levelTabs, levelPanels } = runInit();
  levelTabs.forEach((tab, i) => {
    const panel = levelPanels[i];
    assert.ok(tab.id);
    assert.ok(panel.id);
    assert.equal(tab.getAttribute('aria-controls'), panel.id);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
  });
});

test('ids stay unique across two independent tab widgets on the same page', () => {
  const { groupTabs, groupPanels, levelTabs, levelPanels } = runInit();
  const allIds = [...groupTabs, ...groupPanels, ...levelTabs, ...levelPanels].map((n) => n.id);
  assert.equal(new Set(allIds).size, allIds.length, 'no two elements should share an id: ' + allIds.join(', '));
});

test('a tab\'s aria-controls resolves to a panel actually reachable in the DOM (not a dangling id)', () => {
  const stub = runInit();
  const byId = new Map(
    [...stub.groupTabs, ...stub.groupPanels, ...stub.levelTabs, ...stub.levelPanels].map((n) => [n.id, n])
  );
  [...stub.groupTabs, ...stub.levelTabs].forEach((tab) => {
    const targetId = tab.getAttribute('aria-controls');
    assert.ok(byId.has(targetId), `aria-controls="${targetId}" must resolve to a real panel`);
    assert.equal(byId.get(targetId).getAttribute('role'), 'tabpanel');
  });
});
