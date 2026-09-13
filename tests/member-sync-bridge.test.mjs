// apps-script/member-sync/Code.gs — the HMAC+nonce+replay-window bridge that
// functions/api/verify-premium.js and check-member-status.js call to decide
// whether a real member's access code or Discord handle is honored.
//
// This runs inside Google Apps Script, which nothing here can reach, so
// nothing has ever executed this file (its sibling, content-sync/Code.gs,
// gets exactly this treatment already — see tests/content-bridge-setup.test.mjs).
// A silent regression in verifyMac_/lookupOne_ would ship with every other
// test green: it would either lock out real members or open a bypass, and
// nothing here would notice. So the Apps Script runtime is stubbed and the
// real file is executed against it, the same way its sibling already is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(ROOT, 'apps-script', 'member-sync', 'Code.gs'), 'utf8');

const SECRET = 'test-bridge-secret';

function fakeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return { getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }) };
}

function fakeSpreadsheet(sheet) {
  return {
    getSheetByName: (n) => (n === 'Members' ? sheet : null),
    getSheets: () => [sheet],
  };
}

/** Run Code.gs with a stubbed Apps Script runtime and return its globals. */
function load(spreadsheet, props = {}) {
  const store = { SHEET_ID: 'SHEET_ID_123', BRIDGE_SECRET: SECRET, ...props };
  const nonces = new Map();
  const ctx = {
    SpreadsheetApp: { openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (nonces.has(k) ? '1' : null),
        put: (k) => nonces.set(k, true),
      }),
    },
    console,
    Utilities: {
      computeHmacSignature: (_alg, msg, key) =>
        [...createHmac('sha256', key).update(msg).digest()].map((b) => (b > 127 ? b - 256 : b)),
      MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

/** Signs a request the same way functions/api/verify-premium.js's bridgeMac() does. */
function sign(secret, timestamp, nonce, payload) {
  const raw = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${payload}`).digest();
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function request(body) {
  return { postData: { contents: JSON.stringify(body) } };
}

function signedRequest(query, { secret = SECRET, timestamp = Date.now(), nonce = randomUUID() } = {}) {
  const payload = JSON.stringify(query);
  const mac = sign(secret, timestamp, nonce, payload);
  return request({ timestamp, nonce, payload, mac });
}

const MEMBERS = fakeSheet([
  ['Discord', 'Code', 'Status'],
  ['pj#0001', 'ACTIVE-CODE', 'Active'],
  ['renewedmember', 'RENEWED-CODE', 'Renewed'],
  ['expiredmember', 'EXPIRED-CODE', 'Expired'],
]);

test('a correctly-signed lookup by code returns the matching row', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'ACTIVE-CODE' }));
  assert.deepEqual(JSON.parse(res._t), { ok: true, found: true, discord: 'pj#0001', status: 'Active' });
});

test('a correctly-signed lookup by discord handle returns the matching row', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doPost(signedRequest({ type: 'discord', value: 'renewedmember' }));
  assert.deepEqual(JSON.parse(res._t), { ok: true, found: true, discord: 'renewedmember', status: 'Renewed' });
});

test('an unknown code returns found:false, not a throw', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'NOPE' }));
  assert.deepEqual(JSON.parse(res._t), { ok: true, found: false });
});

test('a wrong MAC is rejected as unauthorized', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const timestamp = Date.now();
  const nonce = randomUUID();
  const payload = JSON.stringify({ type: 'code', value: 'ACTIVE-CODE' });
  const res = ctx.doPost(request({ timestamp, nonce, payload, mac: 'deadbeef'.repeat(8) }));
  assert.equal(JSON.parse(res._t).error, 'unauthorized');
});

test('a stale timestamp outside the replay window is rejected', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const staleTs = Date.now() - 6 * 60 * 1000; // 6 min, window is 5
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'ACTIVE-CODE' }, { timestamp: staleTs }));
  assert.equal(JSON.parse(res._t).error, 'unauthorized');
});

test('a future timestamp outside the replay window is rejected', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const futureTs = Date.now() + 6 * 60 * 1000;
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'ACTIVE-CODE' }, { timestamp: futureTs }));
  assert.equal(JSON.parse(res._t).error, 'unauthorized');
});

test('a replayed nonce is rejected the second time even with a valid MAC', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const timestamp = Date.now();
  const nonce = randomUUID();
  const payload = JSON.stringify({ type: 'code', value: 'ACTIVE-CODE' });
  const mac = sign(SECRET, timestamp, nonce, payload);
  const first = ctx.doPost(request({ timestamp, nonce, payload, mac }));
  assert.equal(JSON.parse(first._t).found, true, 'first use should succeed');
  const second = ctx.doPost(request({ timestamp, nonce, payload, mac }));
  assert.equal(JSON.parse(second._t).error, 'unauthorized', 'replay must be rejected');
});

test('a missing Status header fails closed instead of matching with a blank status', () => {
  // Code column is present and would match; only Status is missing. Without
  // the header guard, lookupOne_ still finds the row (colStatus === -1 reads
  // as undefined -> '' via the `|| ''` fallback) and reports found:true with
  // an empty status instead of refusing the row outright.
  const brokenSheet = fakeSheet([
    ['Discord', 'Code', 'State'], // "status" header renamed/missing
    ['pj#0001', 'ACTIVE-CODE', 'Active'],
  ]);
  const ctx = load(fakeSpreadsheet(brokenSheet));
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'ACTIVE-CODE' }));
  assert.deepEqual(JSON.parse(res._t), { ok: true, found: false });
});

test('an unconfigured secret fails closed rather than accepting every request', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS), { BRIDGE_SECRET: null });
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'ACTIVE-CODE' }));
  assert.deepEqual(JSON.parse(res._t), { ok: false, error: 'not configured' });
});

test('a bad query type is rejected without touching the sheet', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doPost(signedRequest({ type: 'email', value: 'x@y.com' }));
  assert.equal(JSON.parse(res._t).error, 'bad query type');
});

test('a value over the length cap is rejected', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doPost(signedRequest({ type: 'code', value: 'x'.repeat(65) }));
  assert.equal(JSON.parse(res._t).error, 'bad value');
});

test('doGet is always disabled — this bridge is server-to-server only', () => {
  const ctx = load(fakeSpreadsheet(MEMBERS));
  const res = ctx.doGet();
  assert.deepEqual(JSON.parse(res._t), { ok: false, error: 'POST only' });
});
