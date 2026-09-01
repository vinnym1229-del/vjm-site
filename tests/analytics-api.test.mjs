// POST /api/analytics — the first-party funnel collector.
//
// This is the only PUBLIC WRITE endpoint on the site: it has to accept events
// from anonymous visitors, because measuring a funnel means measuring people
// before any session exists. That makes its input rules the whole security
// story — an allowlist of stage names, hard caps on every size, and nothing
// identifying recorded. These tests pin all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

function post(body, env) {
  return onRequestPost({
    request: new Request('https://x/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
