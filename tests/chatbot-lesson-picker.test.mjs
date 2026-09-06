// Regression for the assistant widget's lesson-mode dead end.
//
// A member in lesson mode who asks a question after the lesson's underlying
// text has been re-published (assistant.js returns 409 on a lessonVersion
// mismatch) used to be told "reopen the lesson list and ask again" — but the
// picker row that got them into lesson mode is removed on click and greet()
// (the only place that ever builds one) never runs twice per page load, so
// there was no control left to click. The input box's placeholder also kept
// reading "Ask about this lesson…" even though the widget had silently
// dropped back to plain market-mode Q&A. Fixed by having the 409 handler
// re-fetch and re-render the lesson picker itself and reset the placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const chatbotSrc = readFileSync(join(ROOT, 'assets/chatbot.js'), 'utf8');

// The whole file is one `(() => { ... })();` IIFE; pull it out whole rather
// than a sub-function, since the widget's state (panel/log/input/lesson) is
// private to that closure.
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

// A DOM double covering exactly what this widget touches: createElement,
// classList, append/remove with real parent-tracking (so isConnected reflects
// reality), event listeners, and the plain settable properties (value,
// placeholder, textContent, disabled) the script assigns directly.
function makeDomStub() {
  let bodyRoot;
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
      type: '',
      placeholder: '',
      maxLength: 0,
      disabled: false,
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
      focus() {},
      append(...kids) { kids.forEach((k) => { k.parent = node; node.children.push(k); }); },
      remove() {
        if (node.parent) {
          node.parent.children = node.parent.children.filter((c) => c !== node);
          node.parent = null;
        }
      },
      get isConnected() {
        let n = node;
        while (n) { if (n === bodyRoot) return true; n = n.parent; }
        return false;
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
    findByText: (text) => findAll(bodyRoot, (n) => n.textContent === text),
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('assistant widget: a 409 lesson-version mismatch re-renders the lesson picker instead of stranding the member', async () => {
  const stub = makeDomStub();
  let postCalls = 0;
  const fetchStub = async (url, opts) => {
    assert.equal(url, '/api/assistant');
    if (!opts || !opts.method) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          lessons: [{ id: 'l1', title: 'Lesson One', version: 2, resource: '/futures-dissection.html' }],
        }),
      };
    }
    postCalls++;
    if (postCalls === 1) {
      return { ok: true, status: 200, json: async () => ({ ok: true, narrative: 'Here is your answer.' }) };
    }
    return { ok: false, status: 409, json: async () => ({ ok: false, error: 'stale lesson version' }) };
  };

  const sandbox = {
    document: stub.document,
    window: stub.window,
    fetch: fetchStub,
    location: { pathname: '/futures-dissection.html' },
    console,
  };
  sandbox.window.document = stub.document;
  vm.createContext(sandbox);
  vm.runInContext(extractIife(chatbotSrc), sandbox, { filename: 'chatbot.js' });

  // Open the panel (the widget's init() already ran synchronously; the fab
  // button is the sole top-level child of <body>).
  const fab = stub.findByClass('vjm-chat-fab')[0];
  assert.ok(fab, 'fab button was not created');
  fab.listeners.click[0]();
  await flush();

  const lessonTopicBtn = stub.findByClass('vjm-topic-btn').find((b) => b.textContent.includes('lesson on this page'));
  assert.ok(lessonTopicBtn, 'lesson topic button never appeared after the entitlement fetch resolved');
  lessonTopicBtn.listeners.click[0]();

  const firstPickerBtn = stub.findByText('Lesson One')[0];
  assert.ok(firstPickerBtn, 'lesson picker button never rendered');
  firstPickerBtn.listeners.click[0]();

  const input = stub.findByClass('vjm-chat-input')[0];
  const form = input.parent;
  assert.equal(input.placeholder, 'Ask about this lesson…');

  // First question in lesson mode succeeds.
  input.value = 'What is a stop order?';
  form.listeners.submit[0]({ preventDefault() {} });
  await flush();
  assert.ok(stub.findByText('Here is your answer.')[0], 'the successful lesson answer never rendered');

  // Second question hits the 409 (lesson text changed under the member).
  input.value = 'What about a limit order?';
  form.listeners.submit[0]({ preventDefault() {} });
  await flush();

  assert.equal(
    input.placeholder,
    'Ask about the market…',
    'placeholder must stop claiming lesson mode once the widget has silently dropped out of it'
  );
  assert.ok(
    stub.findByText('That lesson was updated — pick it again from the fresh list below.')[0],
    'the 409 recovery message did not render'
  );
  const secondPickerBtn = stub.findByText('Lesson One')[0];
  assert.ok(secondPickerBtn, 'no fresh lesson picker was rendered after the 409 — the member is stranded with no way back into lesson mode');
  assert.ok(secondPickerBtn.isConnected, 'the re-rendered picker button must actually be attached to the log');
});
