// Incident: index.html's "Am I Active?" Discord status checker
// (checkStatus()) threw away the backend's error message on every non-2xx
// response and always rendered the generic "Status service is temporarily
// down" copy. functions/api/check-member-status.js answers a malformed
// handle (too short, too long, a space, the old name#1234 tag format) with
// HTTP 400 and `{ ok: false, error: 'Enter a valid Discord username.' }` --
// a specific, actionable message -- and a rate-limited visitor gets 429
// with its own specific message. Both got funneled into the same "service
// is down, email support" copy, telling a visitor their own typo was an
// outage.
//
// Fixed by keeping data.error for a 400/429 response and rendering it
// directly instead of the generic outage copy; 502/503/network failures
// (genuine outages) are unaffected and still show the generic message.
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

function run(fixture, fetchStub) {
  const sandbox = { document: fixture.document, fetch: fetchStub, encodeURIComponent, console };
  vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(), sandbox);
  return sandbox;
}

test('checkStatus() shows the backend\'s own message for a 400 bad-handle response, not the generic outage copy', async () => {
  const fx = makeFixture();
  const fetch = async () => ({
    status: 400,
    json: async () => ({ ok: false, error: 'Enter a valid Discord username.' }),
  });
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'a#1234';
  await sandbox.checkStatus();

  assert.equal(fx.nodes['status-text'].textContent, 'CHECK YOUR INPUT');
  assert.equal(fx.nodes['status-sub'].textContent, 'Enter a valid Discord username.');
});

test('checkStatus() shows the backend\'s own message for a 429 rate-limit response', async () => {
  const fx = makeFixture();
  const fetch = async () => ({
    status: 429,
    json: async () => ({ ok: false, error: 'Too many lookups. Wait a minute and try again.' }),
  });
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'someone';
  await sandbox.checkStatus();

  assert.equal(fx.nodes['status-text'].textContent, 'CHECK YOUR INPUT');
  assert.equal(fx.nodes['status-sub'].textContent, 'Too many lookups. Wait a minute and try again.');
});

test('checkStatus() still shows the generic outage copy for a real backend failure (503)', async () => {
  const fx = makeFixture();
  const fetch = async () => ({
    status: 503,
    json: async () => ({ ok: false, error: 'Status lookup is not configured.' }),
  });
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'someone';
  await sandbox.checkStatus();

  assert.equal(fx.nodes['status-text'].textContent, 'LOOKUP UNAVAILABLE');
  assert.equal(fx.nodes['status-sub'].textContent, 'Status service is temporarily down. Contact support in Discord or email pjtradesofficial@gmail.com.');
});

test('checkStatus() still shows the generic outage copy on a network failure (fetch throws)', async () => {
  const fx = makeFixture();
  const fetch = async () => { throw new Error('network down'); };
  const sandbox = run(fx, fetch);

  fx.nodes['status-discord-input'].value = 'someone';
  await sandbox.checkStatus();

  assert.equal(fx.nodes['status-text'].textContent, 'LOOKUP UNAVAILABLE');
});
