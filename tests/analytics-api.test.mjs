// POST /api/analytics — the first-party funnel collector.
//
// This is the only PUBLIC WRITE endpoint on the site: it has to accept events
// from anonymous visitors, because measuring a funnel means measuring people
// before any session exists. That makes its input rules the whole security
// story — an allowlist of stage names, hard caps on every size, and nothing
// identifying recorded. These tests pin all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { onRequestPost, ALLOWED_EVENTS } from '../functions/api/analytics.js';

/** A D1 fake that records what would have been written. */
function fakeDb() {
  const written = [];
  return {
    written,
    prepare(sql) {
      return {
        sql,
        bind(...args) { return { sql, args }; },
      };
    },
    async batch(stmts) { stmts.forEach((s) => written.push(s.args)); return []; },
  };
}

const envWith = (db, extra = {}) => ({ RESEARCH_DB: db, ...extra });

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.9.0.${ipCounter}`;
}

function post(body, env, ip) {
  return onRequestPost({
    request: new Request('https://x/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  });
}

test('an allowlisted event is stored with its props, visit and path', async () => {
  const db = fakeDb();
  const res = await post(
    { visit: 'abc123', events: [{ name: 'plan_cta', props: { plan: 'complete', price: 129 }, path: '/' }] },
    envWith(db),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stored, 1);
  const [name, props, visit, path] = db.written[0];
  assert.equal(name, 'plan_cta');
  assert.deepEqual(JSON.parse(props), { plan: 'complete', price: 129 });
  assert.equal(visit, 'abc123');
  assert.equal(path, '/');
});

test('an unrecognised event name is dropped, not stored', async () => {
  // The allowlist is what stops this becoming a general-purpose write sink for
  // anyone who finds the URL.
  const db = fakeDb();
  const res = await post(
    { visit: 'v', events: [{ name: 'arbitrary_event' }, { name: '../../etc/passwd' }, { name: 'plan_cta' }] },
    envWith(db),
  );
  assert.equal((await res.json()).stored, 1, 'only the allowlisted stage survives');
  assert.equal(db.written.length, 1);
  assert.equal(db.written[0][0], 'plan_cta');
});

test('every stage the client can emit is accepted by the server', async () => {
  // A stage the client fires but the server rejects is a silently missing
  // funnel step, which is worse than no analytics at all.
  const db = fakeDb();
  const events = [...ALLOWED_EVENTS].map((name) => ({ name }));
  const res = await post({ visit: 'v', events }, envWith(db));
  assert.equal((await res.json()).stored, ALLOWED_EVENTS.size);
});

test('oversized and hostile payloads are capped rather than stored', async () => {
  const db = fakeDb();

  // Batch cap.
  const tooMany = Array.from({ length: 26 }, () => ({ name: 'plan_cta' }));
  assert.equal((await post({ events: tooMany }, envWith(db))).status, 400);

  // A huge string prop is truncated; a huge object of props is dropped whole.
  const res = await post({
    visit: 'x'.repeat(500),
    events: [{ name: 'plan_cta', props: { plan: 'y'.repeat(5000) }, path: 'z'.repeat(5000) }],
  }, envWith(db));
  assert.equal(res.status, 200);
  const [, props, visit, path] = db.written[0];
  assert.ok(visit.length <= 64, 'visit id capped');
  assert.ok(path.length <= 160, 'path capped');
  assert.ok(props === null || props.length <= 512, 'props capped or dropped');

  // Nested objects, arrays and functions are never persisted.
  const db2 = fakeDb();
  await post({ events: [{ name: 'plan_cta', props: { nested: { a: 1 }, arr: [1, 2], ok: 'yes' } }] }, envWith(db2));
  assert.deepEqual(JSON.parse(db2.written[0][1]), { ok: 'yes' });
});

test('malformed input is refused without touching storage', async () => {
  const db = fakeDb();
  assert.equal((await post('not json', envWith(db))).status, 400);
  assert.equal((await post({}, envWith(db))).status, 400);
  assert.equal((await post({ events: [] }, envWith(db))).status, 400);
  assert.equal((await post({ events: 'nope' }, envWith(db))).status, 400);
  assert.equal(db.written.length, 0);
});

test('the rate limit trips before storage, per the header comment\'s own promise', async () => {
  // The header comment names rate-limiting as one of three things that make a
  // public write endpoint safe. Nothing pinned that guarantee: every sibling
  // public endpoint (live-stats, forex-calendar, content, ticker) has this
  // exact test; analytics.js was the one public write endpoint without it.
  const db = fakeDb();
  const ip = nextIp();
  const event = { events: [{ name: 'plan_cta' }] };
  let last;
  for (let i = 0; i < 120; i++) last = await post(event, envWith(db), ip);
  assert.equal(last.status, 200, 'the 120th call from one IP in one minute is still allowed');

  const limited = await post(event, envWith(db), ip);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).ok, false);
  assert.equal(db.written.length, 120, 'the rate-limited call never reaches storage');
});

test('an unconfigured deployment says so instead of pretending to store', async () => {
  const res = await post({ events: [{ name: 'plan_cta' }] }, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test('a storage failure never leaks detail to an anonymous caller', async () => {
  const broken = { prepare() { return { bind() { return {}; } }; }, async batch() { throw new Error('D1: table analytics_events has no column named secret_internal'); } };
  const res = await post({ events: [{ name: 'plan_cta' }] }, envWith(broken));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), /secret_internal|D1:/, 'internal error text must not be reflected');
});

test('nothing identifying is recorded', async () => {
  // The insert takes exactly four values, and none of them is an IP, a user
  // agent, or a member identity. If a column is ever added here, this test is
  // the place that should force the privacy page to be updated with it.
  const db = fakeDb();
  await post({ visit: 'v', events: [{ name: 'plan_cta', path: '/' }] }, envWith(db));
  assert.equal(db.written[0].length, 4, 'name, props, visit_id, path — and nothing else');
});

test('every event name emitted anywhere in site code is accepted by the collector', () => {
  // The 'every stage the client can emit is accepted' test above only proves
  // ALLOWED_EVENTS accepts its own members — it can never catch a name that
  // got wired into a page or script but was never added to the allowlist.
  // That's exactly what happened to the homepage quiz's "your answers point
  // at X too" alt-track link: it was tagged data-vjm-event="quiz_track_alt",
  // funnel.js dutifully sent it, and the collector silently dropped every
  // click (200 {ok:true, stored:0}, no error anywhere) because the name was
  // never allowlisted. This scans every page and client script for the name
  // literals themselves, independent of ALLOWED_EVENTS, so a repeat of that
  // mistake fails here instead of just under-counting forever.
  const root = new URL('../', import.meta.url);
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.html')),
    ...readdirSync(new URL('assets/', root)).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`),
  ];
  const patterns = [
    /data-vjm-event=[\\'"]([a-z_]+)[\\'"]/g,
    /setAttribute\(\s*['"]data-vjm-event['"]\s*,\s*['"]([a-z_]+)['"]\s*\)/g,
    /vjmTrack\(\s*['"]([a-z_]+)['"]/g,
    // assets/curriculum.js and assets/newsletter.js each define their own
    // local `function track(name, props)` wrapper around window.vjmTrack and
    // fire literal calls like track('plan_cta', ...) — none of the three
    // patterns above match a bare track(...) call, so this scan produced zero
    // matches in either file despite curriculum.js emitting 4 event names and
    // newsletter.js emitting 1. Same blind spot as the quiz_track_alt bug
    // this test was written to catch, just on a different call shape.
    /\btrack\(\s*['"]([a-z_]+)['"]/g,
  ];
  const found = new Set();
  for (const f of files) {
    const src = readFileSync(new URL(f, root), 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1]);
  }
  assert.ok(found.size > 0, 'sanity check: the scan itself must find events, or it is testing nothing');
  const missing = [...found].filter((name) => !ALLOWED_EVENTS.has(name));
  assert.deepEqual(missing, [], `emitted in site code but missing from ALLOWED_EVENTS: ${missing.join(', ')}`);
});

test('every allowlisted event is actually emitted somewhere in site code', () => {
  // The two tests above check emitted->allowlisted and allowlisted<->reported,
  // but neither catches a stage that was declared and allowlisted at the
  // funnel's inception yet never wired into an actual page or script -- it
  // reads as "nobody ever does this" in the report forever, indistinguishable
  // from a real zero, because there's no code path where the report test
  // above's own "reported but never collectible" check would catch it (the
  // stage IS collectible, it's just never sent). Reuses the same file/pattern
  // scan as the 'emitted anywhere in site code' test above, just checked in
  // the opposite direction.
  const root = new URL('../', import.meta.url);
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.html')),
    ...readdirSync(new URL('assets/', root)).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`),
  ];
  const patterns = [
    /data-vjm-event=[\\'"]([a-z_]+)[\\'"]/g,
    /setAttribute\(\s*['"]data-vjm-event['"]\s*,\s*['"]([a-z_]+)['"]\s*\)/g,
    /vjmTrack\(\s*['"]([a-z_]+)['"]/g,
    /\btrack\(\s*['"]([a-z_]+)['"]/g,
    // curriculum.js's planCtaButton takes an optional dynamic 'extraEvent'
    // built as { name: 'core_to_complete_upgrade', props: {...} } and fires
    // it via track(extraEvent.name, ...) -- the literal-call patterns above
    // never see the name in that shape.
    /\bname:\s*['"]([a-z_]+)['"]/g,
  ];
  const found = new Set();
  const sources = new Map();
  for (const f of files) {
    const src = readFileSync(new URL(f, root), 'utf8');
    sources.set(f, src);
    for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1]);
  }
  // funnel.js fires whop_checkout symbolically -- track(STAGES.WHOP_CHECKOUT,
  // ...) -- rather than a string literal. Resolve STAGES's own key->value
  // literals and follow any STAGES.KEY reference anywhere in site code.
  const funnelSrc = sources.get('assets/funnel.js');
  const stagesBlock = funnelSrc.slice(funnelSrc.indexOf('var STAGES = {'), funnelSrc.indexOf('\n  };', funnelSrc.indexOf('var STAGES = {')));
  const stageValues = new Map([...stagesBlock.matchAll(/([A-Z_]+):\s*'([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
  for (const src of sources.values()) {
    for (const m of src.matchAll(/\bSTAGES\.([A-Z_]+)/g)) {
      if (stageValues.has(m[1])) found.add(stageValues.get(m[1]));
    }
  }
  const neverEmitted = [...ALLOWED_EVENTS].filter((name) => !found.has(name));
  assert.deepEqual(neverEmitted, [], `allowlisted (and reported) but never emitted anywhere: ${neverEmitted.join(', ')}`);
});

test('the funnel report covers every stage the collector accepts', async () => {
  // Drift here is silent and one-directional: add a stage to the collector,
  // forget the report, and the new stage is invisible in the only place anyone
  // looks. The report warns about it at runtime; this fails the build instead.
  const src = readFileSync(new URL('../tools/funnel-report.mjs', import.meta.url), 'utf8');
  const listed = [...src.matchAll(/^\s*\['([a-z_]+)',/gm)].map((m) => m[1]);
  const missing = [...ALLOWED_EVENTS].filter((e) => !listed.includes(e));
  assert.deepEqual(missing, [], `stages accepted but not reported: ${missing.join(', ')}`);
  // …and nothing in the report that the collector would reject, which would
  // print a permanently-empty row and read as "nobody ever did this".
  const stray = listed.filter((e) => !ALLOWED_EVENTS.has(e));
  assert.deepEqual(stray, [], `reported but never collectible: ${stray.join(', ')}`);
});
