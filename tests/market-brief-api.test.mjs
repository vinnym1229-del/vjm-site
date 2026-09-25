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

  // Every third-party call SUCCEEDING was never exercised above (the earlier
  // block only proved the degrade path) -- Alpaca configured, its snapshot
  // and movers endpoints answering, Yahoo's search endpoint returning real
  // headlines, and the ForexFactory calendar feed all resolving together, so
  // no fetch failure could accidentally be standing in for a real assertion.
  // Also exercises maybePostToDiscord's no-narrative branch (dataOnly:true,
  // so it formats brief.lean/brief.movers itself) and its headline-links
  // list, which the AI-narrative test above never reaches because a present
  // narrative takes the other branch.
  {
    const todayIso = new Date().toISOString();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://data.alpaca.markets/v2/stocks/snapshots')) {
        return new Response(JSON.stringify({
          SPY: { latestTrade: { p: 450, t: todayIso }, prevDailyBar: { c: 445 } },
          QQQ: { latestTrade: { p: 380, t: todayIso }, prevDailyBar: { c: 376 } },
        }), { status: 200 });
      }
      if (href.startsWith('https://data.alpaca.markets/v1beta1/screener/stocks/movers')) {
        return new Response(JSON.stringify({
          gainers: [{ symbol: 'NVDA', price_change_percent: 4.2, price: 120 }],
          losers: [{ symbol: 'TSLA', price_change_percent: -2.1, price: 240 }],
        }), { status: 200 });
      }
      if (href.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        const symbol = new URL(href).searchParams.get('q');
        return new Response(JSON.stringify({
          news: [{ title: `${symbol} headline`, link: `https://finance.yahoo.com/news/${symbol}`, providerPublishTime: Math.floor(Date.now() / 1000) }],
        }), { status: 200 });
      }
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([
          { country: 'USD', impact: 'High', date: todayIso },
          { country: 'USD', impact: 'Low', date: todayIso },
          { country: 'EUR', impact: 'High', date: todayIso },
        ]), { status: 200 });
      }
      if (href.startsWith('https://discord.com/api/webhooks/')) return new Response(null, { status: 204 });
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      DISCORD_ANNOUNCEMENTS_WEBHOOK: 'https://discord.com/api/webhooks/1/abc',
      ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.dataOnly, true, 'no AI binding means still data-only here');
    assert.deepEqual(data.brief.warnings, [], 'every source succeeded, so no degrade warnings');
    assert.equal(data.brief.proxies.length, 2);
    assert.equal(data.brief.proxies[0].symbol, 'SPY');
    assert.equal(data.brief.lean.lean, 'long-leaning', 'QQQ +1.06% *2 + SPY +1.12% clears the +0.5 long-leaning threshold');
    assert.equal(data.brief.movers.gainers[0].symbol, 'NVDA');
    assert.equal(data.brief.movers.losers[0].symbol, 'TSLA');
    assert.equal(data.brief.headlines.length, 5, 'one headline per NEWS_SYMBOLS entry');
    assert.equal(data.brief.calendarEventCountToday, 1, 'only the single USD/High row today counts');
    assert.equal(data.discordPosted, true);
    assert.equal(data.discordDetail, 'delivered');
  }

  // A configured webhook that Discord itself rejects (rate-limited, bad
  // token, timeout) must report that distinctly from "not configured" --
  // postEmbed returning false, not throwing, is what maybePostToDiscord
  // turns into this detail string.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://discord.com/api/webhooks/')) return new Response('{}', { status: 401 });
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      DISCORD_ANNOUNCEMENTS_WEBHOOK: 'https://discord.com/api/webhooks/1/abc',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200, 'a rejected webhook post must not fail brief generation itself');
    assert.equal(data.discordPosted, false);
    assert.equal(data.discordDetail, 'webhook rejected or timed out');
  }

  // BRIEF_UNIVERSE (owner-configurable per the file's own header comment) had
  // never been exercised with a valid value anywhere -- every prior test left
  // it unset, so parseUniverse's success branch (lowercase/whitespace input,
  // >=2 symbols) only ever ran the null/fallback-to-DEFAULT_UNIVERSE path.
  // The official movers screener is forced to fail so computedMovers(universe)
  // runs; its own `source` string reports the universe size it actually used,
  // which distinguishes "used my 2-symbol override" from "silently fell back
  // to the 10-symbol default" without needing to inspect internals.
  {
    const todayIso = new Date().toISOString();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://data.alpaca.markets/v1beta1/screener/stocks/movers')) {
        return new Response('', { status: 500 });
      }
      if (href.startsWith('https://data.alpaca.markets/v2/stocks/snapshots')) {
        const symbols = new URL(href).searchParams.get('symbols');
        if (symbols === 'FOO,BAR') {
          return new Response(JSON.stringify({
            FOO: { latestTrade: { p: 10, t: todayIso }, prevDailyBar: { c: 9 } },
            BAR: { latestTrade: { p: 20, t: todayIso }, prevDailyBar: { c: 22 } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('', { status: 500 });
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's',
      BRIEF_UNIVERSE: ' foo, bar ',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.movers.source, 'computed from 2-symbol IEX snapshot universe',
      'a 2-symbol override must not silently widen to the 10-symbol DEFAULT_UNIVERSE');
    assert.equal(data.brief.movers.gainers[0].symbol, 'FOO');
    assert.equal(data.brief.movers.losers[0].symbol, 'BAR');
  }

  // onRequestPost's outer catch (line 59-60) is the last-resort safety net
  // for a genuinely unexpected failure -- every documented third-party/D1
  // failure mode above already degrades gracefully inside generateBrief
  // itself and never reaches here. Nothing in this suite had ever forced
  // that catch to actually fire, so its "truncate to 160 chars, never leak
  // more" contract was unverified. storeBrief's `if (env.RESEARCH_DB)` check
  // is the first env access after generateBrief succeeds and sits outside
  // storeBrief's own D1 try/catch, so a throwing getter there reaches
  // onRequestPost's catch without needing a real production bug.
  {
    globalThis.fetch = alwaysFailFetch;
    const longMessage = 'x'.repeat(200);
    const throwingEnv = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      get RESEARCH_DB() { throw new Error(longMessage); },
    };
    const { status, data } = await postBrief(throwingEnv);
    assert.equal(status, 502);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'Brief generation failed: ' + 'x'.repeat(160),
      'the error detail must be truncated to 160 chars, not the full message');
  }

  // The truncated-error test above always threw a real Error, so `err.message`
  // was always truthy. A rejection with no `.message` at all (a thrown
  // string, or any other non-Error value) must still fall back to *something*
  // useful via `|| err`, not stringify to the literal text "undefined".
  {
    globalThis.fetch = alwaysFailFetch;
    const throwingEnv = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      get RESEARCH_DB() { throw 'plain string failure, not an Error'; },
    };
    const { status, data } = await postBrief(throwingEnv);
    assert.equal(status, 502);
    assert.equal(data.error, 'Brief generation failed: plain string failure, not an Error');
  }

  // Alpaca configured but the SPY/QQQ snapshot call itself failing outright
  // (a 500, not just an empty/malformed shape) must degrade to a warning,
  // not abort the whole brief. This is a distinct guard from movers()'s and
  // computedMovers()'s own internal catches in alpaca.js (both of which
  // already fail closed to null internally and so never actually reject) --
  // every other Alpaca-configured test above has the snapshot call succeed,
  // so this particular catch had never fired.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://data.alpaca.markets/v2/stocks/snapshots')) {
        return new Response('', { status: 500 });
      }
      if (href.startsWith('https://data.alpaca.markets/v1beta1/screener/stocks/movers')) {
        return new Response(JSON.stringify({ gainers: [], losers: [] }), { status: 200 });
      }
      if (href.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        return new Response(JSON.stringify({ news: [] }), { status: 200 });
      }
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.deepEqual(data.brief.proxies, []);
    assert.ok(data.brief.warnings.includes('Index proxy quotes unavailable.'));
    assert.equal(data.brief.lean.lean, 'neutral', 'a failed proxy read must fall back to 0/0 inputs, not skip the lean entirely');
  }

  // A proxy snapshot with a live trade price but no prior-close bar at all
  // (a feed hiccup, or nothing to compare against yet) yields changePct:null,
  // not a number -- Number.isFinite(null) is false, so the dataBlock line
  // built from it must render as a bare price with no percentage suffix
  // rather than interpolating "null%"/"undefined%" into the AI prompt. QQQ
  // is given a NEGATIVE changePct in the same request so the inner
  // `changePct >= 0 ? '+' : ''` sign ternary's other branch (no prior test
  // had ever priced a proxy below its prior close) is exercised too.
  {
    const todayIso = new Date().toISOString();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://data.alpaca.markets/v2/stocks/snapshots')) {
        return new Response(JSON.stringify({
          SPY: { latestTrade: { p: 450, t: todayIso } }, // no prevDailyBar
          QQQ: { latestTrade: { p: 370, t: todayIso }, prevDailyBar: { c: 380 } },
        }), { status: 200 });
      }
      if (href.startsWith('https://data.alpaca.markets/v1beta1/screener/stocks/movers')) {
        return new Response(JSON.stringify({ gainers: [], losers: [] }), { status: 200 });
      }
      if (href.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        return new Response(JSON.stringify({ news: [] }), { status: 200 });
      }
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.proxies[0].symbol, 'SPY');
    assert.equal(data.brief.proxies[0].changePct, null);
    assert.ok(data.brief._dataBlock.includes('SPY: $450\n'), 'no prior close means no "(±N% vs prior close)" suffix, not "null%"');
    assert.match(data.brief._dataBlock, /QQQ: \$370 \(-2\.63% vs prior close\)/, 'a negative changePct must render with no "+" sign, not "-+2.63%" or similar');
  }

  // A Yahoo search response whose `news` field isn't an array at all (an
  // object, e.g. an edge-case/error shape) must degrade that symbol to zero
  // headlines instead of throwing on the for-of -- Array.isArray guards it
  // explicitly, but every prior test always supplied a real array.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        return new Response(JSON.stringify({ news: {} }), { status: 200 });
      }
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: makeDb() };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.deepEqual(data.brief.headlines, []);
    assert.ok(data.brief.warnings.includes('Headline feeds unreachable this run.'));
  }

  // Individual Yahoo news items with a missing title, a missing link, or a
  // non-https link must each be skipped without throwing -- but an item
  // missing only `providerPublishTime` (title/link both present) is still a
  // real, usable headline and must be kept, with publishedAt:null rather
  // than a fabricated timestamp or a dropped item.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://query1.finance.yahoo.com/v1/finance/search')) {
        const symbol = new URL(href).searchParams.get('q');
        if (symbol !== 'SPY') return new Response(JSON.stringify({ news: [] }), { status: 200 });
        return new Response(JSON.stringify({
          news: [
            { link: 'https://finance.yahoo.com/news/no-title' },
            { title: 'No link' },
            { title: 'Bad scheme', link: 'http://finance.yahoo.com/news/bad' },
            { title: 'No pub time', link: 'https://finance.yahoo.com/news/no-pub' },
          ],
        }), { status: 200 });
      }
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: makeDb() };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.headlines.length, 1, 'the three malformed items must be skipped, only the valid one kept');
    assert.equal(data.brief.headlines[0].title, 'No pub time');
    assert.equal(data.brief.headlines[0].publishedAt, null);
  }

  // A calendar event missing its `impact` field entirely must not silently
  // count as high-impact (String(undefined) degrades to '', which correctly
  // excludes it rather than throwing), and a malformed `date` on an
  // otherwise-qualifying USD/High event must be skipped -- Invalid Date
  // makes Intl.DateTimeFormat.format() throw a RangeError -- without
  // aborting the loop for the real event that follows it.
  {
    const todayIso = new Date().toISOString();
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === 'https://nfs.faireconomy.media/ff_calendar_thisweek.json') {
        return new Response(JSON.stringify([
          { country: 'USD', date: todayIso },
          { country: 'USD', impact: 'High', date: 'not-a-date' },
          { country: 'USD', impact: 'High', date: todayIso },
        ]), { status: 200 });
      }
      throw new Error('unexpected fetch target: ' + href);
    };
    const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: makeDb() };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.calendarEventCountToday, 1,
      'the missing-impact and malformed-date rows must neither count nor crash the loop');
  }

  // storeBrief's own D1 write failure (not just an unset RESEARCH_DB) must
  // still degrade to the in-memory fallback and report stored:false, rather
  // than propagate up through onRequestPost's outer catch -- distinct from
  // the throwing-getter case earlier, which fails before storeBrief is ever
  // reached.
  {
    globalThis.fetch = alwaysFailFetch;
    const failingDb = {
      prepare() {
        return { bind() { return { async run() { throw new Error('D1 write failed'); }, async first() { return null; } }; } };
      },
    };
    const env = { RESEARCH_CRON_SECRET: CRON_SECRET, RESEARCH_DB: failingDb };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.stored, false, 'a failed D1 write must fall back to the in-memory brief, not surface as an error');
  }

  // loadBrief's own D1 read failure (not just an absent RESEARCH_DB) must
  // fall back to this isolate's in-memory brief rather than surfacing as an
  // error or reporting "pending" as if nothing had been generated today --
  // the failed-write test just above left memoryBrief populated for today.
  {
    const failingDb = {
      prepare() {
        return { bind() { return { async first() { throw new Error('D1 read failed'); } }; } };
      },
    };
    const { status, data } = await getBrief({ RESEARCH_DB: failingDb });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.date, TODAY);
    assert.equal(data.lean.lean, 'neutral', 'falls back to the in-memory brief the prior D1-write-failure test left behind');
  }

  // BRIEF_UNIVERSE resolving to fewer than 2 valid symbols after filtering
  // (a typo'd single value) must fall back to the 10-symbol DEFAULT_UNIVERSE,
  // not run computedMovers over a 1-symbol universe -- every prior
  // BRIEF_UNIVERSE test only exercised the >=2-symbol success path.
  {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith('https://data.alpaca.markets/v1beta1/screener/stocks/movers')) {
        return new Response('', { status: 500 });
      }
      if (href.startsWith('https://data.alpaca.markets/v2/stocks/snapshots')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('', { status: 500 });
    };
    const env = {
      RESEARCH_CRON_SECRET: CRON_SECRET,
      RESEARCH_DB: makeDb(),
      ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's',
      BRIEF_UNIVERSE: 'onlyone',
    };
    const { status, data } = await postBrief(env);
    assert.equal(status, 200);
    assert.equal(data.brief.movers.source, 'computed from 10-symbol IEX snapshot universe',
      'a single-symbol override is invalid (parseUniverse requires >=2) and must silently fall back to DEFAULT_UNIVERSE');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM market-brief API tests passed.');
