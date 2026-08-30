// Regression coverage for /api/market-brief (functions/api/market-brief.js).
//
// This was the last functions/api/*.js file with zero direct handler test
// references (only a textual wiring check in tests/pj-futures.test.mjs) --
// assistant.js was its sibling and got covered first, leaving this one open.
// Pins: the GET rate-limit gate (30/min), the "no brief generated yet is a
// 200 pending state, not a 404" contract the handler's own comment insists
// on (every homepage visitor before the morning cron runs would otherwise
// log a console error), the POST auth gate (X-Research-Cron, constant-time
// compare, unconfigured secret fails closed), the Alpaca-unconfigured and
// headline/calendar-fetch-failure degrade-to-warnings paths, the D1
// cache_key/payload shape storeBrief/loadBrief round-trip on, the Discord
// dry-run-vs-delivered detail strings, and the file's own documented
// "per-isolate memory fallback" -- when RESEARCH_DB is absent, a POST's
// generated brief must still be readable back by a GET in the same isolate,
// not silently lost.
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/market-brief.js';

const CRON_SECRET = 'brief-cron-secret';

// Mirrors the module's private etDateString() (ET calendar date, en-CA
// yyyy-mm-dd) so tests can build matching cache keys without exporting it.
function etDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
const TODAY = etDateString();

// Minimal D1 fake for the single research_latest cache row market-brief.js
// reads/writes: SELECT payload by cache_key, and an upsert keyed the same way.
function makeDb(seed = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT payload FROM research_latest')) {
                const [cacheKey] = args;
                return rows.has(cacheKey) ? { payload: rows.get(cacheKey) } : null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO research_latest')) {
                const [cacheKey, , , payload] = args;
                rows.set(cacheKey, payload);
                return { meta: { changes: 1 } };
              }
              throw new Error('unhandled query in fake D1: ' + sql);
            },
          };
        },
      };
    },
  };
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.5.0.${ipCounter}`;
}

async function getBrief(env) {
  const res = await onRequestGet({
    request: new Request('https://example.com/api/market-brief', { headers: { 'CF-Connecting-IP': nextIp() } }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

async function postBrief(env, { cron = CRON_SECRET } = {}) {
  const headers = { 'CF-Connecting-IP': nextIp() };
  if (cron !== null) headers['X-Research-Cron'] = cron;
  const res = await onRequestPost({
    request: new Request('https://example.com/api/market-brief', { method: 'POST', headers }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// Fetch mock that fails every third-party call -- used to exercise the
// "everything degrades" paths without hitting the network from a test run.
async function alwaysFailFetch() {
  throw new Error('simulated third-party outage');
}

// Rate limit trips at 30/min, before any brief lookup can matter. Run first,
// with no RESEARCH_DB, so it can't be polluted by state a later test writes.
{
  const ip = nextIp();
  let last;
  for (let i = 0; i < 30; i++) {
    const res = await onRequestGet({
      request: new Request('https://example.com/api/market-brief', { headers: { 'CF-Connecting-IP': ip } }),
      env: {},
    });
    last = { status: res.status, data: await res.json() };
  }
  assert.equal(last.status, 200);

  const limitedRes = await onRequestGet({
    request: new Request('https://example.com/api/market-brief', { headers: { 'CF-Connecting-IP': ip } }),
    env: {},
  });
  assert.equal(limitedRes.status, 429);
  const limited = await limitedRes.json();
  assert.equal(limited.ok, false);
}

// No brief generated yet today: 200 with pending:true, never a 404 -- the
// handler's own comment says callers gate on ok/pending, not status code.
{
  const { status, data } = await getBrief({ RESEARCH_DB: makeDb() });
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.pending, true);
  assert.equal(data.date, TODAY);
}

// A cached row for today is returned as ok:true, merged with its payload.
{
  const cached = { date: TODAY, narrative: 'Cached brief text', lean: { lean: 'long-leaning' }, calendarEventCountToday: 2 };
  const db = makeDb({ [`market_brief:${TODAY}`]: JSON.stringify(cached) });
  const { status, data } = await getBrief({ RESEARCH_DB: db });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.narrative, 'Cached brief text');
  assert.deepEqual(data.lean, { lean: 'long-leaning' });
  assert.equal(data.calendarEventCountToday, 2);
}

// POST auth gate: unconfigured secret, missing header, and wrong header all
// reject before any generation work starts.
{
  const { status } = await postBrief({});
  assert.equal(status, 401);
}
{
  const { status, data } = await postBrief({ RESEARCH_CRON_SECRET: CRON_SECRET }, { cron: null });
  assert.equal(status, 401);
  assert.match(data.error, /Unauthorized/);
}
{
  const { status } = await postBrief({ RESEARCH_CRON_SECRET: CRON_SECRET }, { cron: 'not-the-secret' });
  assert.equal(status, 401);
}

const originalFetch = globalThis.fetch;
try {
  // Alpaca unconfigured and every third-party fetch failing: the brief still
  // generates (never a 502) but degrades to explicit warnings, a neutral
  // lean off zero-value proxies, null headlines/calendar rather than
  // fabricated data, and -- with no RESEARCH_DB -- an in-memory store.
  {
    globalThis.fetch = alwaysFailFetch;
    const { status, data } = await postBrief({ RESEARCH_CRON_SECRET: CRON_SECRET });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.stored, false, 'no RESEARCH_DB means the in-memory fallback, not a D1 write');
    assert.equal(data.brief.lean.lean, 'neutral');
    assert.ok(data.brief.warnings.includes('Alpaca not configured — lean and movers omitted.'));
    assert.ok(data.brief.warnings.includes('Headline feeds unreachable this run.'));
    assert.equal(data.brief.calendarEventCountToday, null);
    assert.equal(data.brief.dataOnly, true, 'no AI binding means data-only, not a fabricated narrative');
    assert.equal(data.discordPosted, false);
  }

  // The file's own comment documents a per-isolate memory fallback when
  // RESEARCH_DB is absent -- prove the brief the prior POST just generated
  // is actually readable back by GET in this isolate, not silently dropped.
  {
    const { status, data } = await getBrief({});
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.date, TODAY);
    assert.equal(data.lean.lean, 'neutral');
  }

  // With RESEARCH_DB configured, the brief is written under the exact
  // cache_key storeBrief/loadBrief both key on, and no Discord webhook means
  // an explicit not-configured detail string rather than a silent skip.
  {
    const db = makeDb();
    globalThis.fetch = alwaysFailFetch;
    const { status, data } = await postBrief({ RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: db });
    assert.equal(status, 200);
    assert.equal(data.stored, true);
    assert.ok(db.rows.has(`market_brief:${TODAY}`));
    assert.equal(JSON.parse(db.rows.get(`market_brief:${TODAY}`)).date, TODAY);
    assert.equal(data.discordPosted, false);
    assert.equal(data.discordDetail, 'DISCORD_ANNOUNCEMENTS_WEBHOOK not configured (dry-run: nothing sent)');
  }

  // AI binding present (narrative generated) and a real-shaped Discord
  // webhook configured: the narrative gets posted and delivery is reported.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://discord.com/api/webhooks/')) return new Response(null, { status: 204 });
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      DISCORD_ANNOUNCEMENTS_WEBHOOK: 'https://discord.com/api/webhooks/1/abc',
      AI: { run: async () => ({ response: 'Index posture: steady.' }) },
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.dataOnly, false);
    assert.equal(data.brief.narrativeEngine, 'cloudflare-workers-ai');
    assert.equal(data.discordPosted, true);
    assert.equal(data.discordDetail, 'delivered');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM market-brief API tests passed.');
