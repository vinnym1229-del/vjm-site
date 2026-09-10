// Regression for the assistant widget losing keyboard focus on close.
//
// toggle(false) is the single place that hides the chat panel (it drives
// .vjm-chat-panel.open, which controls display:none/flex). The Escape-key
// handler always called btn.focus() (the 💬 FAB) right after toggle(false)
// to return keyboard focus per the ARIA dialog pattern (WCAG 2.4.3) — but
// the visible "×" close button's own click handler called toggle(false)
// directly and never returned focus. Since the close button lives inside
// the panel that display:none hides, a keyboard/screen-reader user who
// clicked "×" (rather than pressing Escape) had focus silently dropped to
// <body>, losing their place on the page. Fixed by moving the btn.focus()
// call into toggle() itself so every path that closes the panel returns
// focus the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const chatbotSrc = readFileSync(join(ROOT, 'assets/chatbot.js'), 'utf8');

// Same whole-IIFE extraction tests/chatbot-lesson-picker.test.mjs uses — the
// widget's panel/input/btn state is private to this closure.
function extractIife(source) {
  const start = source.indexOf('(() => {');
  assert.ok(start > -1, 'chatbot.js no longer opens with its expected top-level IIFE');
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        const tail = /^\)\(\);/.exec(source.slice(i + 1, i + 5));
        assert.ok(tail, 'IIFE closing brace not followed by the expected )();');
        return source.slice(start, i + 1 + tail[0].length);
      }
    }
  }
  throw new Error('unbalanced braces in chatbot.js');
}

// A minimal DOM double: just enough for init()/ensurePanel() to run and for
// this test to see which node last received focus() and which class list a
// node carries.
function makeDomStub() {
  let bodyRoot;
  let focused = null;
  function makeNode(tag) {
    const node = {
      tag,
      children: [],
      parent: null,
      listeners: {},
      attrs: {},
      _classes: [],
      textContent: '',
      value: '',
      innerHTML: '',
      get className() { return node._classes.join(' '); },
      set className(v) { node._classes = v ? String(v).split(/\s+/) : []; },
      classList: {
        add: (c) => { if (!node._classes.includes(c)) node._classes.push(c); },
        remove: (c) => { node._classes = node._classes.filter((x) => x !== c); },
        toggle: (c, force) => {
          const has = node._classes.includes(c);
          const want = force === undefined ? !has : force;
          if (want && !has) node._classes.push(c);
          if (!want && has) node._classes = node._classes.filter((x) => x !== c);
        },
        contains: (c) => node._classes.includes(c),
      },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
      addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
      focus() { focused = node; },
      append(...kids) { kids.forEach((k) => { k.parent = node; node.children.push(k); }); },
      remove() {
        if (node.parent) {
          node.parent.children = node.parent.children.filter((c) => c !== node);
          node.parent = null;
        }
      },
    };
    return node;
  }
  bodyRoot = makeNode('body');
  const head = makeNode('head');
  const docListeners = {};
  const document = {
    readyState: 'complete',
    body: bodyRoot,
    head,
    createElement: (tag) => makeNode(tag),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };
  const window = { matchMedia: () => ({ matches: false }) };
  function findAll(root, predicate) {
    const out = [];
    (function walk(n) {
      if (predicate(n)) out.push(n);
      n.children.forEach(walk);
    })(root);
    return out;
  }
  return {
    document,
    window,
    fireKeydown(key) { (docListeners.keydown || []).forEach((fn) => fn({ key })); },
    findByClass: (cls) => findAll(bodyRoot, (n) => n._classes.includes(cls)),
    get focused() { return focused; },
  };
}

function run(stub) {
  const sandbox = {
    document: stub.document,
    window: stub.window,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, lessons: [] }) }),
    location: { pathname: '/' },
    console,
  };
  sandbox.window.document = stub.document;
  vm.createContext(sandbox);
  vm.runInContext(extractIife(chatbotSrc), sandbox, { filename: 'chatbot.js' });
}

test('assistant widget: the visible × close button returns focus to the FAB, same as Escape', () => {
  const stub = makeDomStub();
  run(stub);

  const fab = stub.findByClass('vjm-chat-fab')[0];
  assert.ok(fab, 'fab button was not created');
  fab.listeners.click[0]();

  const panel = stub.findByClass('vjm-chat-panel')[0];
  assert.ok(panel.classList.contains('open'), 'panel did not open');

  const closeBtn = stub.findByClass('vjm-chat-close')[0];
  assert.ok(closeBtn, 'close button was not created');
  closeBtn.listeners.click[0]();

  assert.equal(panel.classList.contains('open'), false, 'panel did not close');
  assert.equal(
    stub.focused,
    fab,
    'closing via the visible × button must return focus to the FAB, not strand it on a hidden element'
  );
});

test('assistant widget: Escape still returns focus to the FAB (no regression, no double-focus)', () => {
  const stub = makeDomStub();
  run(stub);

  stub.findByClass('vjm-chat-fab')[0].listeners.click[0]();
  stub.fireKeydown('Escape');

  const panel = stub.findByClass('vjm-chat-panel')[0];
  assert.equal(panel.classList.contains('open'), false, 'Escape did not close the panel');
  assert.equal(stub.focused, stub.findByClass('vjm-chat-fab')[0], 'Escape must still return focus to the FAB');
});
