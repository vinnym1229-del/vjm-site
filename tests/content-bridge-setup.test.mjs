// apps-script/content-sync/Code.gs — the setUp() that has to work first time.
//
// This code runs inside Google Apps Script, which nothing here can reach, and
// the owner runs it exactly once against a real spreadsheet full of real
// content. "Run it and see" is not an acceptable test plan when the failure
// mode is overwriting a sheet. So the Apps Script runtime is stubbed and the
// real file is executed against it.
//
// What is actually being pinned is the destructive-operation guarantee: run
// setUp() twice, or against a sheet that already has content, and nothing is
// overwritten. Everything else in the file is convenience; that part is the
// one that can lose someone's work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(ROOT, 'apps-script', 'content-sync', 'Code.gs'), 'utf8');

/** A spreadsheet stand-in: just enough surface for what Code.gs touches. */
function fakeSheet(name, rows = []) {
  const grid = rows.map((r) => r.slice());
  return {
    name,
    grid,
    getLastRow: () => grid.length,
    setFrozenRows() {},
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(row, col, numRows, numCols) {
      return {
        setValues(values) {
          for (let i = 0; i < numRows; i++) {
            const target = row - 1 + i;
            while (grid.length <= target) grid.push([]);
            for (let j = 0; j < numCols; j++) grid[target][col - 1 + j] = values[i][j];
          }
          return this;
        },
        setFontWeight() { return this; },
      };
    },
  };
}

function fakeSpreadsheet(sheets = {}) {
  const map = new Map(Object.entries(sheets));
  return {
    getId: () => 'SHEET_ID_123',
    getName: () => 'Content',
    getSheetByName: (n) => map.get(n) || null,
    insertSheet(n) { const s = fakeSheet(n); map.set(n, s); return s; },
    _sheets: map,
  };
}

/** Run Code.gs with a stubbed Apps Script runtime and return its globals. */
function load(spreadsheet, props = {}) {
  const store = { ...props };
  const logs = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = v; },
      }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    Logger: { log: (m) => logs.push(String(m)) },
    console,
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
      computeDigest: (_alg, s) => [...createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)),
      // Apps Script returns signed bytes; mirroring that matters because
      // computeMac_ does the +256 correction and a stub of unsigned bytes
      // would let a broken correction pass.
      computeHmacSignature: (_alg, msg, key) => [...createHmac('sha256', key).update(msg).digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d) => d.toISOString().slice(0, 10),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, store, logs, spreadsheet };
}

test('setUp creates every tab the bridge reads, with the right headers', () => {
  const ss = fakeSpreadsheet();
  const { ctx } = load(ss);
  ctx.setUp();

  // The reader in doPost names nine collections; all nine must be created, or
  // the first sync silently returns an empty list for the missing one.
  //
  // Copied out of the VM before comparing: arrays created inside a vm context
  // have that context's Array.prototype, so a strict deep-equal against them
  // fails on the prototype even when every element matches.
  for (const [name, headers] of ctx.TABS) {
    const sheet = ss._sheets.get(name);
    assert.ok(sheet, `${name} tab was not created`);
    assert.deepEqual([...sheet.grid[0]], [...headers], `${name} has the wrong header row`);
  }
  assert.equal(ss._sheets.size, ctx.TABS.length);
});

test('setUp is safe to run twice — it overwrites nothing', () => {
  // The whole reason this is testable at all: the owner will run it against a
  // sheet that already has their content in it, probably more than once.
  const existing = fakeSheet('PropFirms', [
    ['id', 'name', 'url', 'code', 'discount', 'image_url', 'notes', 'active', 'my_extra_column'],
    ['pf1', 'A Firm', 'https://x', 'PJ', '35%', '', '', 'true', 'do not lose me'],
  ]);
  const ss = fakeSpreadsheet({ PropFirms: existing });
  const { ctx, store } = load(ss);

  ctx.setUp();
  const firstSecret = store.CONTENT_BRIDGE_SECRET;
  const scheduleAfterFirst = ss._sheets.get('Schedule').grid.map((r) => r.slice());

  ctx.setUp();
  ctx.setUp();

  assert.deepEqual(existing.grid[1], ['pf1', 'A Firm', 'https://x', 'PJ', '35%', '', '', 'true', 'do not lose me'],
    'an existing row was modified');
  assert.equal(existing.grid[0][8], 'my_extra_column', 'an extra column was clobbered');
  assert.equal(store.CONTENT_BRIDGE_SECRET, firstSecret, 'the secret must not be regenerated — Cloudflare would stop matching');
  assert.deepEqual(ss._sheets.get('Schedule').grid, scheduleAfterFirst, 'the seed was applied twice');
});

test('the schedule seed matches what the site currently shows, and only seeds once', () => {
  const ss = fakeSpreadsheet();
  const { ctx } = load(ss);
  ctx.setUp();
  const grid = ss._sheets.get('Schedule').grid;

  // 15 real sessions + the one explicitly-off slot, the same 16 rows the
  // hard-coded grid renders. If these disagree, turning the sync on silently
  // changes the page — which is exactly what a seed exists to prevent.
  assert.equal(grid.length - 1, 16, 'seed row count changed');
  const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const staticRows = (index.replace(/<script[\s\S]*?<\/script>/gi, '')
    .match(/<div class="session-row"/g) || []).length;
  const staticOff = (index.replace(/<script[\s\S]*?<\/script>/gi, '')
    .match(/<div class="session-row-off"/g) || []).length;
  assert.equal(grid.length - 1, staticRows + staticOff,
    'the seed and the hard-coded grid disagree about the week');

  // A blank host is how an off slot is expressed; the renderer keys off that.
  const off = grid.slice(1).filter((r) => !String(r[4]).trim());
  assert.equal(off.length, staticOff);
  assert.equal(off[0][5], 'No live trading');

  // Sessions must use the names the server validates against, or the row is
  // dropped by sanitizeContentRow and the day quietly loses a session.
  for (const row of grid.slice(1)) {
    assert.ok(['NYAM', 'NYPM', 'CLASS', 'ASIA'].includes(row[2]), `bad session name: ${row[2]}`);
    assert.ok(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(row[1]), `bad day: ${row[1]}`);
    assert.ok(row[0], 'every row needs an id or the bridge drops it');
  }
});

test('the generated secret is long, hex, and not from Math.random', () => {
  const ss = fakeSpreadsheet();
  const { ctx } = load(ss);
  const a = ctx.randomSecret_();
  const b = ctx.randomSecret_();
  assert.match(a, /^[0-9a-f]{64}$/, '256 bits of hex');
  assert.notEqual(a, b);
  // Math.random() is seeded and predictable; this is the one value standing
  // between a public /exec URL and the spreadsheet.
  // Match on USE, not on the word: the file explains in a comment why
  // Math.random is the wrong tool here, and a bare word match hit that comment.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /Math\.random\s*\(/, 'Math.random must not generate the shared secret');
});

test('healthCheck reports missing tabs and id-less rows without leaking content', () => {
  // The two failures that actually happen, and are otherwise invisible: a tab
  // that was never made, and rows whose id column is blank (the bridge drops
  // those silently, so the sheet looks full and the site stays empty).
  const ss = fakeSpreadsheet({
    Schedule: fakeSheet('Schedule', [
      ['id', 'day', 'session', 'time_et', 'host', 'note', 'active'],
      ['', 'Mon', 'NYAM', '9:30 AM ET', 'Someone', '', 'true'],
    ]),
  });
  const { ctx } = load(ss);
  const out = ctx.healthCheck();

  assert.match(out, /Schedule: 0 usable row\(s\)/);
  assert.match(out, /id column cannot be blank/);
  assert.match(out, /PropFirms: TAB MISSING/);
  assert.doesNotMatch(out, /Someone/, 'health output must not echo sheet content');
});

test('a GET confirms the URL without revealing anything about the sheet', () => {
  const ss = fakeSpreadsheet({ Schedule: fakeSheet('Schedule', [['id'], ['s1']]) });
  const { ctx } = load(ss);
  const body = JSON.parse(ctx.doGet()._t);
  assert.deepEqual(body, { ok: true, service: 'content-bridge', method: 'POST' });
  // No tab names, no counts, no content: this endpoint is reachable by anyone.
  assert.doesNotMatch(ctx.doGet()._t, /Schedule|row|sheet/i);
});

test('an unsigned POST is still rejected, setUp or no setUp', () => {
  const ss = fakeSpreadsheet();
  const { ctx } = load(ss);
  ctx.setUp();                                  // secret now exists
  const res = ctx.doPost({ postData: { contents: JSON.stringify({
    timestamp: Date.now(), nonce: 'n', payload: '{"action":"all"}', mac: 'deadbeef',
  }) } });
  assert.equal(JSON.parse(res._t).error, 'unauthorized');
});
