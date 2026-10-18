// Incident: index.html's "Am I Active?" Discord status checker
// (checkStatus(), the ─── AM I ACTIVE STATUS CHECKER ─── block) has no
// request-sequencing guard, unlike its sibling ask() in assets/chatbot.js,
// which solves the identical problem with a `busy` flag. A visitor can
// submit one handle, then edit the input and submit a second handle before
// the first lookup's fetch resolves. Nothing here tracked which request was
// newer, so if the first (now stale) request happened to resolve after the
// second, its result silently overwrote the screen -- telling the visitor
// someone else's membership status while a different handle sat in the
// input box.
//
// Fixed with a monotonically increasing request counter captured before
// each fetch; a response that resolves after a newer request has started is
// discarded instead of rendered. This drives the real checkStatus()
// (extracted verbatim from the shipped inline script, not reimplemented)
// with two fetches resolved deliberately out of order and asserts the
// final DOM state reflects the newer request, never the stale one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function extractInlineScript() {
  const html = read('index.html');
  const start = html.indexOf('// ─── AM I ACTIVE STATUS CHECKER ───');
  assert.ok(start > -1, 'could not find the index.html status-checker script block');
  const end = html.indexOf('// ─── GROWTH SIMULATOR ───', start);
  assert.ok(end > start, 'could not find the end marker (// ─── GROWTH SIMULATOR ───) after the status-checker script');
  return html.slice(start, end);
}

function makeNode() {
  return { style: {}, attrs: {}, textContent: '', innerHTML: '', value: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } };
}

function makeFixture() {
  const nodes = {
    'status-discord-input': makeNode(),
    'status-result': makeNode(),
    'status-icon': makeNode(),
    'status-text': makeNode(),
    'status-sub': makeNode(),
  };
  const document = {
    getElementById: (id) => nodes[id] || null,
    addEventListener() {},
  };
  return { nodes, document };
}

// Returns a fetch stub plus a map of handle -> {resolve} so the test can
// settle each in-flight request in whatever order it chooses.
function makeControllableFetch() {
  const pending = {};
  const fetch = (url) => {
    const handle = decodeURIComponent(/discord=([^&]+)/.exec(url)[1]);
    return new Promise((resolve) => { pending[handle] = resolve; });
  };
  const settle = (handle, active) => {
    pending[handle]({ json: async () => ({ ok: true, active }) });
  };
  return { fetch, settle };
}

function run(fixture, fetchStub) {
  const sandbox = {
    document: fixture.document,
    fetch: fetchStub,
    encodeURIComponent,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(), sandbox);
  return sandbox;
}

test('checkStatus() ignores a stale response that resolves after a newer request has started', async () => {
  const fx = makeFixture();
  const { fetch, settle } = makeControllableFetch();
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'alice';
  const firstCall = sandbox.checkStatus(); // request A in flight

  fx.nodes['status-discord-input'].value = 'bob';
  const secondCall = sandbox.checkStatus(); // request B in flight before A resolves

  // Resolve the OLDER request (alice) after the newer one (bob) -- the
  // exact ordering a slow backend path or a cold cache can produce.
  settle('bob', true);
  await secondCall;
  settle('alice', false);
  await firstCall;

  assert.equal(fx.nodes['status-text'].textContent, 'ACTIVE',
    'the stale "alice" response must not overwrite the newer "bob" result');
  assert.equal(fx.nodes['status-sub'].textContent, 'Your premium is active. You should have your Discord role.');
});

test('checkStatus() still renders a response that resolves in request order', async () => {
  const fx = makeFixture();
  const { fetch, settle } = makeControllableFetch();
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'carol';
  const call = sandbox.checkStatus();
  settle('carol', false);
  await call;

  assert.equal(fx.nodes['status-text'].textContent, 'NOT ACTIVE');
});
