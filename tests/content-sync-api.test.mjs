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
// bridge-unreachable 502, that a malformed row is skipped rather than
// upserted, the endpoint's own 20/min rate-limit guard (this file's own
// header comment: "without a limit the shared secret is brute-forceable" --
// every sibling secret-gated/public endpoint already has this exact test,
// this one didn't), and that a Discord post failure doesn't get recorded as
// posted, so a transient webhook outage is retried next sync instead of the
// announcement being silently dropped forever.
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
function makeDb({ postedAnnouncementIds = new Set(), failInsertIds = new Set() } = {}) {
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
                // args[1] is external_id (the ?2 bind) -- lets a test force a
                // single row's write to fail without touching every row.
                if (failInsertIds.has(args[1])) throw new Error('constraint violation');
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

  // A real non-2xx HTTP status must reject even when the body happens to
  // parse as valid, well-shaped JSON -- e.g. an Apps Script proxy that
  // wraps a genuine 503 in an otherwise-normal-looking response. Without
  // its own explicit status check this would fall through to the ok:true
  // shape check and succeed with the (empty) body instead of failing.
  {
    globalThis.fetch = async () => Response.json({ ok: true, content: {} }, { status: 503 });
    const { status, data } = await postSync(baseEnv());
    assert.equal(status, 502);
    assert.match(data.error, /unreachable/);
  }

  // A thrown non-Error (fetch/AbortSignal can reject with a plain reason
  // rather than an Error) has no .message property, so `err && err.message`
  // is falsy and the detail string must fall back to the thrown value
  // itself instead of stringifying to "undefined".
  {
    globalThis.fetch = async () => { throw 'upstream reset'; };
    const { status, data } = await postSync(baseEnv());
    assert.equal(status, 502);
    assert.equal(data.detail, 'upstream reset');
  }

  // content:null must also 502, not crash: typeof null === 'object', so a
  // naive `typeof data.content !== 'object'` check lets null through and the
  // per-type loop below throws on bridgeData[type] uncaught. This is a real
  // shape the bridge could send (e.g. a serialization bug), distinct from
  // the ok:false and content-missing cases above.
  {
    globalThis.fetch = async () => Response.json({ ok: true, content: null });
    const { status, data } = await postSync(baseEnv());
    assert.equal(status, 502);
    assert.match(data.error, /unreachable/);
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

  // A single D1 insert failure (e.g. a constraint violation on one row)
  // must skip just that row and keep processing the rest of the batch, not
  // abort the whole sync -- one bad row from the sheet shouldn't cost the
  // owner every other row in the same hourly run.
  {
    const db = makeDb({ failInsertIds: new Set(['fails']) });
    globalThis.fetch = mockBridgeFetch({ announcements: [announcement('fails'), announcement('ok-1')] });
    const { status, data } = await postSync(baseEnv(db));
    assert.equal(status, 200);
    assert.equal(data.summary.announcements.received, 2);
    assert.equal(data.summary.announcements.upserted, 1);
    assert.equal(data.summary.announcements.skipped, 1);
  }

  // Discord embed fallbacks: a row that sanitizeContentRow allows through
  // with no title (body-only is valid) must not post an empty embed title,
  // and a row with a real link must render the "Link:" line -- every prior
  // fixture always set a title and never set a link, so neither fallback
  // had ever actually rendered.
  {
    const db = makeDb();
    const sentBodies = [];
    globalThis.fetch = async (url, opts) => {
      const href = String(url);
      if (href === BRIDGE_URL) {
        return Response.json({
          ok: true,
          content: {
            announcements: [
              { id: 'no-title', body: 'Body only, no title' },
              { id: 'has-link', title: 'Linked', body: 'text', link: 'https://vjm.com/post' },
            ],
          },
        });
      }
      if (href.startsWith('https://discord.com/api/webhooks/')) {
        sentBodies.push(JSON.parse(opts.body));
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { ...baseEnv(db), DISCORD_ANNOUNCEMENTS_WEBHOOK: DISCORD_HOOK, CONTENT_DISCORD_DRYRUN: 'false' };
    const { data } = await postSync(env);
    assert.equal(data.discord.posted, 2);
    assert.equal(sentBodies[0].embeds[0].title, 'Announcement', 'a row with no title falls back to a generic embed title, not an empty one');
    assert.match(sentBodies[1].embeds[0].description, /Link: <https:\/\/vjm\.com\/post>/, 'a row with a real link renders the Link line in the embed');
  }

  // The 10-per-sync Discord cap must actually trip: 11 genuinely new
  // announcements in one sync should post only the first 10, leaving the
  // 11th unposted -- and unrecorded, so it's picked up on the next hourly
  // sync instead of silently posting all 11 or crashing past the cap.
  {
    const db = makeDb();
    const rows = Array.from({ length: 11 }, (_, i) => announcement(`cap-${i}`));
    let discordCalls = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === BRIDGE_URL) return Response.json({ ok: true, content: { announcements: rows } });
      if (href.startsWith('https://discord.com/api/webhooks/')) {
        discordCalls++;
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { ...baseEnv(db), DISCORD_ANNOUNCEMENTS_WEBHOOK: DISCORD_HOOK, CONTENT_DISCORD_DRYRUN: 'false' };
    const { data } = await postSync(env);
    assert.equal(data.discord.posted, 10, 'the 10-per-sync cap must trip at exactly 10');
    assert.equal(discordCalls, 10);
    assert.ok(!db.postedAnnouncementIds.has('cap-10'), 'the 11th announcement must not be recorded as posted, so it is retried next sync');
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

  // A Discord post failure (non-204, e.g. rate-limited) must NOT be recorded
  // in webhook_events -- postEmbed's own contract (discord-lib.test.mjs)
  // returns false on anything but 204, and this handler only marks an
  // announcement posted (and counts it toward the 10-per-sync cap) inside
  // `if (ok)`. If a failed post were still recorded, the announcement would
  // be silently dropped forever instead of retried on the next hourly sync.
  {
    const db = makeDb();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === BRIDGE_URL) return Response.json({ ok: true, content: { announcements: [announcement('flaky-1')] } });
      if (href.startsWith('https://discord.com/api/webhooks/')) return new Response(null, { status: 429 });
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { ...baseEnv(db), DISCORD_ANNOUNCEMENTS_WEBHOOK: DISCORD_HOOK, CONTENT_DISCORD_DRYRUN: 'false' };
    const { data } = await postSync(env);
    assert.equal(data.discord.posted, 0, 'a failed post must not count toward the posted total');
    assert.ok(!db.postedAnnouncementIds.has('flaky-1'), 'a failed post must not be recorded as delivered, so it is retried next sync');
  }
} finally {
  globalThis.fetch = originalFetch;
}

// The 20/min rate-limit guard is the first thing onRequestPost does -- ahead
// of even the cron-secret check -- so it must trip regardless of whether the
// caller is authorized. This file's own header comment names the limit as
// the thing standing between the shared cron secret and a brute-force
// guesser; every sibling secret-gated endpoint (research-engine's cron path,
// verify-premium, analytics) already pins this exact guarantee and this file
// didn't.
{
  const ip = '10.2.9.1';
  const headers = { 'X-Research-Cron': CRON_SECRET, 'CF-Connecting-IP': ip };
  // No CONTENT_BRIDGE_URL/SECRET configured, so every allowed request 503s
  // deterministically without ever touching the network -- the point here is
  // only whether the 21st request in a minute gets through the rate gate.
  const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: makeDb() };
  let last;
  for (let i = 0; i < 20; i++) {
    last = await onRequestPost({
      request: new Request('https://example.com/api/content-sync', { method: 'POST', headers }),
      env,
    });
  }
  assert.equal(last.status, 503, 'sanity: the 20th request still reaches the CONTENT_BRIDGE_URL config check');
  const limited = await onRequestPost({
    request: new Request('https://example.com/api/content-sync', { method: 'POST', headers }),
    env,
  });
  assert.equal(limited.status, 429);
  const limitedData = await limited.json();
  assert.equal(limitedData.ok, false);
}

console.log('# VJM content-sync API tests passed.');
