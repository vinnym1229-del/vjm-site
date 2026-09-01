// The newsletter statements, run against a real SQLite rather than a fake.
//
// tests/newsletter-api.test.mjs asserts on the SQL as text, which is the right
// way to pin intent but cannot catch a statement that does not parse or an
// upsert whose ON CONFLICT clause silently matches nothing. Both of those ship
// green and fail on the first real subscriber.
//
// So this file loads migrations/0008_newsletter.sql into an in-memory database,
// wires the same handlers to it through a D1-shaped adapter, and drives the
// actual signup / re-signup / opt-out / re-signup-after-opt-out sequence,
// checking the rows afterwards. D1 is SQLite, so the dialect is the same one
// that runs in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost as subscribe } from '../functions/api/newsletter/subscribe.js';
import { onRequestPost as unsubscribe, onRequestGet as unsubscribeGet } from '../functions/api/newsletter/unsubscribe.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The subset of the D1 client surface these handlers use, over node:sqlite. */
function d1(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { return { results: db.prepare(sql).all(...args) }; },
          };
        },
      };
    },
  };
}

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'migrations', '0008_newsletter.sql'), 'utf8'));
  return { env: { RESEARCH_DB: d1(db) }, db };
}

let ip = 0;
const req = (url, body) => new Request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++ip % 250}:${ip}` },
  body: JSON.stringify(body),
});
const signUp = (env, body) => subscribe({ request: req('https://x/api/newsletter/subscribe', body), env });
const optOut = (env, body) => unsubscribe({ request: req('https://x/api/newsletter/unsubscribe', body), env });
const rows = (db) => db.prepare('SELECT * FROM newsletter_subscribers ORDER BY id').all();

test('the migration applies and the real signup statement runs', async () => {
  const { env, db } = freshEnv();
  const res = await signUp(env, { email: 'Reader@Example.com', firstName: 'Sam', consent: true, source: 'home' });
  assert.equal(res.status, 200);

  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].email, 'reader@example.com');
  assert.equal(all[0].first_name, 'Sam');
  assert.equal(all[0].status, 'subscribed');
  assert.equal(all[0].source, 'home');
  assert.match(all[0].unsub_token, /^[0-9a-f]{64}$/);
});

test('signing up twice leaves ONE row, keeping the original token and source', async () => {
  // The failure this rules out is not hypothetical: an ON CONFLICT target that
  // does not match the unique index throws, and an INSERT without one appends
  // a second row — after which unsubscribing clears one and the mail keeps
  // arriving from the other. Neither is visible in a fake.
  const { env, db } = freshEnv();
  await signUp(env, { email: 'reader@example.com', firstName: 'Sam', consent: true, source: 'home' });
  const first = rows(db)[0];

  await signUp(env, { email: '  READER@example.com ', consent: true, source: 'prop-firms' });

  const all = rows(db);
  assert.equal(all.length, 1, 'a differently-cased duplicate must not become a second row');
  assert.equal(all[0].unsub_token, first.unsub_token, 'unsubscribe links already in inboxes keep working');
  assert.equal(all[0].source, 'home', 'the original source survives — "where did you get my address"');
  assert.equal(all[0].first_name, 'Sam', 'a later submit without a name does not blank the one we have');
});

test('opting out suppresses the row, and the row is what stops the next import', async () => {
  const { env, db } = freshEnv();
  await signUp(env, { email: 'reader@example.com', consent: true });

  const res = await optOut(env, { email: 'Reader@Example.com ' });
  assert.equal(res.status, 200);

  const all = rows(db);
  assert.equal(all.length, 1, 'the address is suppressed, never deleted');
  assert.equal(all[0].status, 'unsubscribed');
  assert.ok(all[0].unsubscribed_at, 'the opt-out is timestamped');
});

test('the one-click token link opts the right person out', async () => {
  const { env, db } = freshEnv();
  await signUp(env, { email: 'a@example.com', consent: true });
  await signUp(env, { email: 'b@example.com', consent: true });
  const [a, b] = rows(db);

  const res = await unsubscribeGet({
    request: new Request(`https://x/api/newsletter/unsubscribe?token=${a.unsub_token}`, {
      headers: { 'CF-Connecting-IP': `198.51.100.${++ip % 250}` },
    }),
    env,
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /state=done$/);

  const after = rows(db);
  assert.equal(after.find((r) => r.email === a.email).status, 'unsubscribed');
  assert.equal(after.find((r) => r.email === b.email).status, 'subscribed', 'nobody else is touched');
});

test('someone who opts out and deliberately signs up again is re-subscribed', async () => {
  // The opposite behaviour — refusing to re-add a suppressed address — is a
  // real pattern, but it is wrong for a public signup form: the person is
  // standing there asking for the emails and would get silence.
  const { env, db } = freshEnv();
  await signUp(env, { email: 'reader@example.com', consent: true });
  await optOut(env, { email: 'reader@example.com' });
  assert.equal(rows(db)[0].status, 'unsubscribed');

  await signUp(env, { email: 'reader@example.com', consent: true });
  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'subscribed');
  assert.equal(all[0].unsubscribed_at, null, 'the stale opt-out timestamp is cleared');
});

test('the send-time query returns only people who are actually opted in', async () => {
  const { env, db } = freshEnv();
  await signUp(env, { email: 'in@example.com', consent: true });
  await signUp(env, { email: 'out@example.com', consent: true });
  await optOut(env, { email: 'out@example.com' });

  const sendList = db.prepare(
    "SELECT email FROM newsletter_subscribers WHERE status = 'subscribed' ORDER BY created_at"
  ).all().map((r) => r.email);
  assert.deepEqual(sendList, ['in@example.com']);
});

test('a mailbox provider\'s one-click POST works, form-encoded, no JSON', async () => {
  // RFC 8058: Gmail and Apple Mail render their own unsubscribe button from
  // the List-Unsubscribe headers, then POST `List-Unsubscribe=One-Click` with
  // the token in the query string and no JSON body at all. Reading only
  // request.json() made that arrive as a 400 — the button would appear in
  // every inbox and do nothing, which is worse than not offering it.
  const { env, db } = freshEnv();
  await signUp(env, { email: 'reader@example.com', consent: true });
  const token = rows(db)[0].unsub_token;

  const res = await unsubscribe({
    request: new Request(`https://x/api/newsletter/unsubscribe?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': `198.51.100.${++ip % 250}` },
      body: 'List-Unsubscribe=One-Click',
    }),
    env,
  });
  assert.equal(res.status, 200);
  assert.equal(rows(db)[0].status, 'unsubscribed');
});
