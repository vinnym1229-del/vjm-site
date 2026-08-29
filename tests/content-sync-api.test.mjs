// Regression coverage for /api/content-sync (functions/api/content-sync.js).
//
// This was the last functions/api/*.js file with zero test references. It's
// the hourly owner-content pipeline: Google Sheet -> HMAC bridge -> D1
// site_content -> Discord announcements webhook. The handler's own comment
// already documents a real fixed bug that nothing pinned:
//   "Cap the number POSTED, not the number considered: newAnnouncements
//    holds every upserted row, so slicing candidates meant a genuinely new
//    announcement past index 9 was silently never posted once the sheet
//    held more than ten rows."
// i.e. once >10 announcements exist and the first 10 are already-posted
// (recorded in webhook_events from a prior sync), the announcements at
// index 10+ must still reach Discord — capping candidates instead of posts
// would silently drop them forever. Also pins the auth gate (cron secret,
// constant-time compare via timingSafeEqual), the config-missing 503s, a
// bridge-unreachable 502, and that a malformed row is skipped rather than
// upserted.
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/content-sync.js';

const CRON_SECRET = 'cron-test-secret';
const BRIDGE_URL = 'https://script.google.com/macros/s/fake/exec';
const BRIDGE_SECRET = 'bridge-test-secret';
const DISCORD_HOOK = 'https://discord.com/api/webhooks/123/abc';

// Minimal D1 fake covering exactly the queries content-sync.js issues.
// site_content upserts are just counted; webhook_events tracks which
// announcement ids have already been posted, matching the real idempotency
// table so the "already posted" skip path is exercised for real.
function makeDb({ postedAnnouncementIds = new Set() } = {}) {
  return {
    postedAnnouncementIds,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT event_id FROM webhook_events')) {
                const [, eventId] = args;
                return postedAnnouncementIds.has(eventId) ? { event_id: eventId } : null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO site_content')) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO webhook_events')) {
                const [eventId] = args;
                postedAnnouncementIds.add(eventId);
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
async function postSync(env, { cron = CRON_SECRET } = {}) {
  ipCounter += 1;
  const headers = { 'CF-Connecting-IP': `10.2.0.${ipCounter}` };
  if (cron !== null) headers['X-Research-Cron'] = cron;
  const res = await onRequestPost({
    request: new Request('https://example.com/api/content-sync', { method: 'POST', headers }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

function baseEnv(db) {
  return {
    RESEARCH_CRON_SECRET: CRON_SECRET,
    CONTENT_BRIDGE_URL: BRIDGE_URL,
    CONTENT_BRIDGE_SECRET: BRIDGE_SECRET,
    RESEARCH_DB: db || makeDb(),
  };
}

function announcement(id, overrides = {}) {
  return { id, title: `Announcement ${id}`, body: 'Body text', ...overrides };
}

function mockBridgeFetch(content) {
  return async (url) => {
    const href = String(url);
    if (href === BRIDGE_URL) {
      return Response.json({ ok: true, content });
    }
    throw new Error('unexpected fetch target: ' + href);
  };
}

// Auth gate: no secret configured, missing header, wrong header — all reject
// before touching CONTENT_BRIDGE_URL/RESEARCH_DB config checks.
{
  const { status } = await postSync({ CONTENT_BRIDGE_URL: BRIDGE_URL, CONTENT_BRIDGE_SECRET: BRIDGE_SECRET, RESEARCH_DB: makeDb() });
  assert.equal(status, 401);
}
{
  const { status, data } = await postSync(baseEnv(), { cron: null });
  assert.equal(status, 401);
  assert.match(data.error, /Unauthorized/);
}
{
  const { status } = await postSync(baseEnv(), { cron: 'wrong-secret' });
  assert.equal(status, 401);
}

// Config-missing fails closed after auth passes.
{
  const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: makeDb() };
  const { status, data } = await postSync(env);
  assert.equal(status, 503);
  assert.match(data.error, /CONTENT_BRIDGE/);
}
{
  const env = { RESEARCH_CRON_SECRET: CRON_SECRET, CONTENT_BRIDGE_URL: BRIDGE_URL, CONTENT_BRIDGE_SECRET: BRIDGE_SECRET };
  const { status, data } = await postSync(env);
  assert.equal(status, 503);
  assert.match(data.error, /RESEARCH_DB/);
}

const originalFetch = globalThis.fetch;
try {
  // Bridge unreachable (network error) surfaces as a 502, not a 500 or a
  // silently empty sync.
  {
    globalThis.fetch = async () => { throw new Error('DNS failure'); };
    const { status, data } = await postSync(baseEnv());
    assert.equal(status, 502);
    assert.match(data.error, /unreachable/);
  }

  // Bridge responds but with the wrong shape (ok:false, or content missing) —
  // also a 502, never treated as an empty-but-valid sync.
  {
    globalThis.fetch = async () => Response.json({ ok: false });
    const { status } = await postSync(baseEnv());
    assert.equal(status, 502);
  }

  // A malformed row (no id) is skipped, not upserted; a valid row is upserted.
  {
    const db = makeDb();
    globalThis.fetch = mockBridgeFetch({ announcements: [{ title: 'no id here' }, announcement('a1')] });
    const { status, data } = await postSync(baseEnv(db));
    assert.equal(status, 200);
    assert.equal(data.summary.announcements.received, 2);
    assert.equal(data.summary.announcements.upserted, 1);
    assert.equal(data.summary.announcements.skipped, 1);
  }

  // The documented bug: 12 announcements, the first 10 (by sheet order)
  // already posted to Discord in a prior sync, the last 2 are genuinely new.
  // Capping the CANDIDATE list at 10 (the old, buggy behavior) would drop
  // those 2 forever, since they'd never even be considered. Capping the
  // POST COUNT instead means they get through.
  {
    const alreadyPosted = new Set(Array.from({ length: 10 }, (_, i) => `old-${i}`));
    const db = makeDb({ postedAnnouncementIds: alreadyPosted });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => announcement(`old-${i}`)),
      announcement('new-1'),
      announcement('new-2'),
    ];
    let discordCalls = 0;
    globalThis.fetch = async (url, opts) => {
      const href = String(url);
      if (href === BRIDGE_URL) return Response.json({ ok: true, content: { announcements: rows } });
      if (href.startsWith('https://discord.com/api/webhooks/')) {
        discordCalls++;
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { ...baseEnv(db), DISCORD_ANNOUNCEMENTS_WEBHOOK: DISCORD_HOOK, CONTENT_DISCORD_DRYRUN: 'false' };
    const { status, data } = await postSync(env);
    assert.equal(status, 200);
    assert.equal(data.discord.posted, 2, 'both genuinely-new announcements past index 9 must be posted');
    assert.equal(discordCalls, 2);
    assert.ok(db.postedAnnouncementIds.has('new-1'));
    assert.ok(db.postedAnnouncementIds.has('new-2'));
  }

  // Dry run (default) never calls Discord even with new announcements and a
  // webhook configured.
  {
    const db = makeDb();
    globalThis.fetch = mockBridgeFetch({ announcements: [announcement('dry-1')] });
    const env = { ...baseEnv(db), DISCORD_ANNOUNCEMENTS_WEBHOOK: DISCORD_HOOK };
    const { data } = await postSync(env);
    assert.equal(data.discord.posted, 0);
    assert.equal(data.discord.dryRun, true);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM content-sync API tests passed.');
