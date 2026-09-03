// Regression coverage for /api/content (functions/api/content.js).
//
// This was one of the two remaining probe-targeted endpoints (the run
// cycle's own live-deployment check hits /api/content?type=schedule by
// curl) with zero test references -- ticker.js, the other one, now has
// tests/ticker-api.test.mjs. content.js's own comment documents a real
// fixed bug that nothing pinned: the trade_reviews ticker filter used to run in JS AFTER
// the SQL query had already truncated to 60 rows by position, so once more
// than 60 reviews existed, an older ticker could return count:0 even though
// its rows were sitting in the table -- just past the LIMIT. The fix pushes
// the ticker match into the SQL itself (json_extract, parameterized) so the
// LIMIT applies to matching rows, not to all rows of the type. Also pins:
// unknown type 400s, missing RESEARCH_DB fails closed (503), a malformed
// payload row is skipped rather than throwing, announcements sort pinned
// first, and team/faqs/results (ORDERED_TYPES) sort by their order field.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/content.js';

// Fake D1 mirroring exactly the two query shapes content.js issues: a plain
// per-type SELECT, and the ticker-filtered SELECT using json_extract. Rows
// carry a `position` (SQL ORDER BY position) and a JSON `payload` string
// (parsed the same way the real column is). The ticker-filtered branch
// matches BEFORE limiting, exactly like the real parameterized SQL would --
// if content.js regresses to filtering by ticker only in JS after an
// unfiltered LIMIT 60, this fake takes the "else" branch instead and the
// truncation-order regression test below fails.
function makeDb(rows) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              const [type, ticker] = args;
              let matched = rows.filter((r) => r.content_type === type);
              if (sql.includes('json_extract')) {
                matched = matched.filter((r) => JSON.parse(r.payload).ticker === ticker);
              }
              matched.sort((a, b) => a.position - b.position);
              return { results: matched.slice(0, 60) };
            },
          };
        },
      };
    },
  };
}

function row(content_type, position, payload) {
  return { content_type, position, payload: JSON.stringify(payload) };
}

let ipCounter = 0;
async function getContent(env, qs) {
  ipCounter += 1;
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/content?${qs}`, {
      headers: { 'CF-Connecting-IP': `10.3.0.${ipCounter}` },
    }),
    env,
  });
  return { status: res.status, data: await res.json() };
}

// The 120/min rate-limit guard trips before the RESEARCH_DB check -- it's
// the first thing onRequestGet does, ahead of even the type validation, so
// a fixed IP must see its 121st request in one minute rejected regardless
// of what it's asking for.
{
  const ip = '10.6.0.1';
  let last;
  for (let i = 0; i < 120; i++) {
    last = await onRequestGet({
      request: new Request('https://example.com/api/content?type=schedule', {
        headers: { 'CF-Connecting-IP': ip },
      }),
      env: {},
    });
  }
  assert.equal(last.status, 503, 'sanity: the 120th request still reaches the RESEARCH_DB check');
  const limited = await onRequestGet({
    request: new Request('https://example.com/api/content?type=schedule', {
      headers: { 'CF-Connecting-IP': ip },
    }),
    env: {},
  });
  assert.equal(limited.status, 429);
  const limitedData = await limited.json();
  assert.equal(limitedData.ok, false);
}

// Unknown type rejected before any RESEARCH_DB check.
{
  const { status, data } = await getContent({}, 'type=bogus');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
  assert.ok(Array.isArray(data.supported) && data.supported.includes('schedule'));
}

// RESEARCH_DB not bound: fails closed (503), not an empty 200.
{
  const { status, data } = await getContent({}, 'type=schedule');
  assert.equal(status, 503);
  assert.equal(data.ok, false);
  assert.match(data.hint, /RESEARCH_DB/);
}

// Basic fetch returns parsed payloads, and a malformed JSON row is skipped
// rather than throwing or surfacing as an error.
{
  const db = makeDb([
    row('faqs', 1, { q: 'Is this free?', order: 2 }),
    { content_type: 'faqs', position: 2, payload: 'not-json' },
    row('faqs', 3, { q: 'How do I sign up?', order: 1 }),
  ]);
  const { status, data } = await getContent({ RESEARCH_DB: db }, 'type=faqs');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.count, 2, 'the malformed row must be dropped, not thrown or counted');
}

// ORDERED_TYPES (team/faqs/results) sort by payload.order ascending,
// independent of SQL row position.
{
  const db = makeDb([
    row('team', 1, { name: 'Second', order: 2 }),
    row('team', 2, { name: 'First', order: 1 }),
  ]);
  const { data } = await getContent({ RESEARCH_DB: db }, 'type=team');
  assert.deepEqual(data.items.map((i) => i.name), ['First', 'Second']);
}

// Announcements sort pinned-first, regardless of the order field (which
// announcements don't carry).
{
  const db = makeDb([
    row('announcements', 1, { title: 'Regular', pinned: 0 }),
    row('announcements', 2, { title: 'Pinned', pinned: 1 }),
  ]);
  const { data } = await getContent({ RESEARCH_DB: db }, 'type=announcements');
  assert.deepEqual(data.items.map((i) => i.title), ['Pinned', 'Regular']);
}

// The documented bug: 70 trade_review rows for the same content_type, with
// the 6 matching a given ticker sitting past position 60. Pushing the match
// into SQL means all 6 come through; truncating to 60 rows of the type
// first (the old, buggy behavior) would leave 0.
{
  const rows = [];
  for (let i = 1; i <= 64; i++) rows.push(row('trade_reviews', i, { ticker: 'OTHER', note: `n${i}` }));
  for (let i = 65; i <= 70; i++) rows.push(row('trade_reviews', i, { ticker: 'NVDA', note: `n${i}` }));
  const db = makeDb(rows);
  const { status, data } = await getContent({ RESEARCH_DB: db }, 'type=trade_reviews&ticker=NVDA');
  assert.equal(status, 200);
  assert.equal(data.count, 6, 'ticker matches past position 60 must not be truncated away before the filter runs');
}

// The ticker query param is ignored for every type except trade_reviews.
{
  const db = makeDb([row('schedule', 1, { day: 'Mon', ticker: 'AAPL' })]);
  const { data } = await getContent({ RESEARCH_DB: db }, 'type=schedule&ticker=NVDA');
  assert.equal(data.count, 1, 'ticker filter must only apply to trade_reviews');
}

// SQL failure surfaces as a 502, not a 500 or a fabricated empty result.
{
  const db = { prepare() { return { bind() { return { async all() { throw new Error('D1 down'); } }; } }; } };
  const { status, data } = await getContent({ RESEARCH_DB: db }, 'type=schedule');
  assert.equal(status, 502);
  assert.equal(data.ok, false);
}

console.log('# VJM content API tests passed.');
