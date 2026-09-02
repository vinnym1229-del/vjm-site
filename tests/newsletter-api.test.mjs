// The newsletter: /api/newsletter/subscribe and /api/newsletter/unsubscribe.
//
// This is the only place on the site that stores a personal identifier from an
// anonymous visitor, so the rules that matter are not "does it save a row" but:
// one row per address, an opt-out that cannot be undone by a stray re-import,
// and neither endpoint answering the question "is this address on your list?".
// These tests pin all three, plus the things that make the opt-out legally
// real rather than decorative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost as subscribe, onRequestGet, normalizeEmail, cleanName, newUnsubToken } from '../functions/api/newsletter/subscribe.js';
import { onRequestPost as unsubscribe, onRequestGet as unsubscribeGet, cleanToken } from '../functions/api/newsletter/unsubscribe.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** A D1 fake that records the SQL and bindings each call would have run. */
function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind: (...args) => ({ async run() { calls.push({ sql, args }); return {}; } }) };
    },
  };
}
const envWith = (db, extra = {}) => ({ RESEARCH_DB: db, ...extra });

// The shared rate limiter buckets by client IP, and every request in this file
// would otherwise arrive from the same 'unknown' address and trip the limit
// partway through the run. Each call gets its own IP so the tests measure the
// handler rather than the bucket.
let ip = 0;
const post = (handler, body, env, url = 'https://x/api/newsletter/subscribe') => handler({
  request: new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${++ip % 250}:${ip}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
  env,
});

const signup = (extra = {}, env) => post(subscribe, { email: 'A.Person@Example.COM', consent: true, ...extra }, env);

/* ── subscribe ─────────────────────────────────────────────────────────── */

test('a consented signup stores one normalised row', async () => {
  const db = fakeDb();
  const res = await signup({ firstName: 'Sam', source: 'home' }, envWith(db));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).subscribed, true);
  assert.equal(db.calls.length, 1);
  const [email, name, source, token] = db.calls[0].args;
  assert.equal(email, 'a.person@example.com', 'address is lowercased so dedupe works');
  assert.equal(name, 'Sam');
  assert.equal(source, 'home');
  assert.match(token, /^[0-9a-f]{64}$/, 'every subscriber gets an unguessable unsubscribe token');
});

test('a repeat signup upserts the one row instead of appending a second', async () => {
  // Two rows for one person means unsubscribing clears one and the mail keeps
  // coming. The uniqueness has to live in the statement, not in hope.
  const db = fakeDb();
  await signup({}, envWith(db));
  const { sql } = db.calls[0];
  assert.match(sql, /ON CONFLICT\(email\) DO UPDATE/i);
  assert.match(sql, /status\s*=\s*'subscribed'/i, 'a returning subscriber is re-subscribed…');
  assert.match(sql, /unsubscribed_at\s*=\s*NULL/i, '…and their opt-out timestamp cleared');
  // The original token survives, so unsubscribe links in already-sent mail work.
  assert.doesNotMatch(sql, /unsub_token\s*=\s*excluded/i);
  // …as does the original source, so "where did you get my address" is answerable.
  assert.match(sql, /source\s*=\s*COALESCE\(newsletter_subscribers\.source/i);
  assert.match(read('migrations/0008_newsletter.sql'), /CREATE UNIQUE INDEX[^;]*newsletter_subscribers \(email\)/i,
    'the database must enforce one row per address too');
});

test('no consent flag, no signup', async () => {
  const db = fakeDb();
  const res = await post(subscribe, { email: 'a@b.com' }, envWith(db));
  assert.equal(res.status, 400);
  const res2 = await post(subscribe, { email: 'a@b.com', consent: 'yes' }, envWith(db));
  assert.equal(res2.status, 400, 'a truthy value is not an affirmative opt-in');
  assert.equal(db.calls.length, 0, 'nothing is stored without consent');
});

test('the response never reveals whether an address was already subscribed', async () => {
  // Otherwise the form is an email-existence oracle for anyone with a list.
  const db = fakeDb();
  const first = await signup({}, envWith(db));
  const again = await signup({}, envWith(db));
  assert.equal(first.status, again.status);
  assert.deepEqual(await first.json(), await again.json());
});

test('bad addresses are refused and the honeypot is answered blandly', async () => {
  const db = fakeDb();
  for (const bad of ['', 'not-an-email', 'a@b', 'a b@c.com', 'a@b .com', `${'x'.repeat(250)}@b.com`, null, 42]) {
    const res = await post(subscribe, { email: bad, consent: true }, envWith(db));
    assert.equal(res.status, 400, `${String(bad).slice(0, 20)} must be refused`);
  }
  assert.equal(db.calls.length, 0);

  // A filled honeypot answers 200 so a bot learns nothing, but stores nothing.
  const res = await post(subscribe, { email: 'a@b.com', consent: true, website: 'http://spam' }, envWith(db));
  assert.equal(res.status, 200);
  assert.equal(db.calls.length, 0, 'the honeypot submission is not stored');
});

test('an unconfigured deployment refuses rather than pretending to store', async () => {
  // A form that says "you're subscribed" and drops the address is the worst
  // possible outcome: the person believes they signed up and never hears back.
  const res = await signup({}, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test('a storage failure never leaks detail and never claims success', async () => {
  const broken = { prepare() { return { bind: () => ({ async run() { throw new Error('D1: no such table newsletter_subscribers'); } }) }; } };
  const res = await post(subscribe, { email: 'a@b.com', consent: true }, envWith(broken));
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /D1:|no such table/);
});

test('turnstile is enforced the moment the owner configures it, and skipped before', async () => {
  const db = fakeDb();
  // Unconfigured: no token needed (the soft-required pattern used site-wide).
  assert.equal((await signup({}, envWith(db))).status, 200);
  // Configured but unverifiable (the fetch fails in this environment): refused.
  const res = await signup({ turnstileToken: 'nope' }, envWith(db, { TURNSTILE_SECRET_KEY: 'k' }));
  assert.equal(res.status, 403);
  assert.equal(db.calls.length, 1, 'the rejected signup stored nothing');
});

test('helpers: normalisation, name cleaning, token shape', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeEmail('foo@bar'), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(cleanName('  Sam  '), 'Sam');
  assert.equal(cleanName('Ana Maria'), 'Ana Maria', 'spaces inside a name are kept');
  assert.equal(cleanName('   '), null);
  assert.notEqual(newUnsubToken(), newUnsubToken(), 'tokens are random, not derived');
  assert.equal(newUnsubToken().length, 64);
});

/* ── unsubscribe ───────────────────────────────────────────────────────── */

const UNSUB = 'https://x/api/newsletter/unsubscribe';

test('unsubscribing suppresses the row, it never deletes it', async () => {
  // A deleted address is silently re-addable by the next form submit or list
  // import, which is exactly how an opt-out gets undone. Suppression has to
  // outlive the subscription.
  const db = fakeDb();
  const res = await post(unsubscribe, { email: 'a@b.com' }, envWith(db), UNSUB);
  assert.equal(res.status, 200);
  const { sql } = db.calls[0];
  assert.match(sql, /UPDATE newsletter_subscribers/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.match(sql, /status\s*=\s*'unsubscribed'/i);
  assert.match(sql, /unsubscribed_at\s*=\s*datetime/i);
});

test('a token from an email footer opts out without the address being typed', async () => {
  const db = fakeDb();
  const token = newUnsubToken();
  await post(unsubscribe, { token, email: 'someone-elses@address.com' }, envWith(db), UNSUB);
  assert.match(db.calls[0].sql, /WHERE unsub_token = \?1/);
  assert.equal(db.calls[0].args[0], token, 'the token wins over any address in the same body');
});

test('the one-click GET link works without JavaScript and lands on the page', async () => {
  const db = fakeDb();
  const token = newUnsubToken();
  const res = await unsubscribeGet({ request: new Request(`${UNSUB}?token=${token}`, { headers: { 'CF-Connecting-IP': `203.0.113.${++ip}` } }), env: envWith(db) });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/unsubscribe\.html\?state=done$/);
  assert.equal(db.calls.length, 1, 'the address is removed before the reader sees the page');

  // A junk token changes nothing and says so rather than claiming success.
  const db2 = fakeDb();
  const bad = await unsubscribeGet({ request: new Request(`${UNSUB}?token=../../etc`, { headers: { 'CF-Connecting-IP': `203.0.113.${++ip}` } }), env: envWith(db2) });
  assert.match(bad.headers.get('location'), /state=invalid$/);
  assert.equal(db2.calls.length, 0);

  // A well-formed token that never matched a row (already used on a prior
  // click, or simply unknown) still redirects to 'done' — the UPDATE runs and
  // reports no error even when it changes nothing, and this handler never
  // inspects a changed-rows count to tell the two cases apart. 'invalid' is
  // reachable only through the malformed-token branch above.
  const db3 = fakeDb();
  const reused = await unsubscribeGet({ request: new Request(`${UNSUB}?token=${newUnsubToken()}`, { headers: { 'CF-Connecting-IP': `203.0.113.${++ip}` } }), env: envWith(db3) });
  assert.match(reused.headers.get('location'), /state=done$/, 're-clicking a spent link must not read as invalid');
});

test('the one-click link copy does not promise a state the handler cannot reach', () => {
  // The client-side 'invalid' message used to say a link "has already been
  // used" — but a reused, well-formed token redirects to 'done' (proven
  // above), never 'invalid'. Telling a user their link failed for a reason
  // that in fact always succeeds is worse than saying nothing about it.
  const js = read('assets/newsletter.js');
  assert.doesNotMatch(js, /already been used/i);
});

test('unsubscribe is not an email-existence oracle either', async () => {
  const db = fakeDb();
  const a = await post(unsubscribe, { email: 'on-the-list@b.com' }, envWith(db), UNSUB);
  const b = await post(unsubscribe, { email: 'never-heard-of-them@b.com' }, envWith(db), UNSUB);
  assert.equal(a.status, b.status);
  assert.deepEqual(await a.json(), await b.json());
});

test('unsubscribe never reports success it did not achieve', async () => {
  // The one place where an honest failure matters more than a tidy screen: a
  // person told they are unsubscribed when nothing was written will not check.
  assert.equal((await post(unsubscribe, { email: 'a@b.com' }, {}, UNSUB)).status, 503);
  const broken = { prepare() { return { bind: () => ({ async run() { throw new Error('boom'); } }) }; } };
  assert.equal((await post(unsubscribe, { email: 'a@b.com' }, envWith(broken), UNSUB)).status, 502);
  assert.equal((await post(unsubscribe, {}, envWith(fakeDb()), UNSUB)).status, 400);
  assert.equal(cleanToken('NOT-HEX'), null);
  assert.equal(cleanToken('a'.repeat(64)), 'a'.repeat(64));
});

/* ── the pages that use it ─────────────────────────────────────────────── */

test('every signup form carries an affirmative consent box and an opt-out route', () => {
  for (const page of ['index.html', 'prop-firms.html']) {
    const html = read(page);
    assert.match(html, /class="nl-signup"/, `${page} must carry the signup form`);
    assert.match(html, /unsubscribe\.html/, `${page} must link the opt-out next to the form`);
    assert.match(html, /privacy\.html/, `${page} must link the privacy policy`);
  }
  // The quiz's own capture goes through the same endpoint and the same rule.
  assert.match(read('index.html'), /id="quiz-lead-consent"/);
  assert.match(read('assets/funnel.js'), /LEAD_ENDPOINT = '\/api\/newsletter\/subscribe'/);
  assert.match(read('assets/funnel.js'), /consent: p\.consent === true/, 'the helper must not supply consent itself');
});

test('each individual nl-signup form is fully wired, not just the page as a whole', () => {
  // index.html now carries two of these (the "home" newsletter section and the
  // giveaway section added alongside it). The whole-page substring match above
  // can't tell a fully-wired form from one missing its consent box or honeypot,
  // as long as some OTHER form on the same page still has them — it would have
  // passed unchanged even if the giveaway form had shipped with no honeypot at
  // all. Scope every check to each individual <form> so a defect in one can't
  // hide behind a sibling.
  for (const page of ['index.html', 'prop-firms.html']) {
    const html = read(page);
    const forms = [...html.matchAll(/<form class="nl-signup"[\s\S]*?<\/form>/g)].map((m) => m[0]);
    assert.ok(forms.length >= 1, `${page} has no nl-signup form to check`);
    const seenIds = new Set();
    for (const form of forms) {
      const source = form.match(/data-source="([^"]+)"/)?.[1];
      assert.ok(source, `${page}: every nl-signup form must declare data-source (DB rows and analytics need it to tell entries apart)`);
      assert.match(form, /type="email"[^>]*\brequired\b/, `${page} [${source}]: email field must be required`);
      assert.match(form, /class="nl-hp"/, `${page} [${source}]: needs its own honeypot field`);
      assert.match(form, /<input type="checkbox"[^>]*name="consent"/, `${page} [${source}]: needs an unticked consent box`);
      assert.doesNotMatch(form, /name="consent"[^>]*\bchecked\b/, `${page} [${source}]: must not pre-tick consent`);
      assert.match(form, /role="status" aria-live="polite"/, `${page} [${source}]: submit feedback needs a live region`);
      const id = form.match(/id="(nl-consent-[^"]+)"/)?.[1];
      assert.ok(id, `${page} [${source}]: consent checkbox needs an id its label can reference`);
      assert.ok(!seenIds.has(id), `${page}: duplicate consent checkbox id "${id}" — two forms on one page can't share it without breaking the other's label`);
      seenIds.add(id);
      assert.match(form, new RegExp(`for="${id}"`), `${page} [${source}]: label must reference the consent checkbox's own id`);
    }
  }
});

test('the unsubscribe page works, and is kept out of the index', () => {
  const page = read('unsubscribe.html');
  assert.match(page, /class="nl-unsub"/);
  assert.match(page, /id="nl-state"/, 'the one-click redirect needs somewhere to report');
  assert.match(page, /meta name="robots" content="noindex,nofollow"/);
  assert.match(read('_headers'), /\/unsubscribe\.html\n\s+X-Robots-Tag: noindex, nofollow/);
  // The policy has to describe the list, not just the site's other data.
  const privacy = read('privacy.html');
  assert.match(privacy, /<h2>The Newsletter<\/h2>/);
  assert.match(privacy, /suppression record/, 'the policy must explain why an opt-out is not a deletion');
});

/* ── the Turnstile handshake ───────────────────────────────────────────── */

test('the config endpoint serves the site key and never the secret', async () => {
  // The SITE key is public by design — it is meant to be read out of page HTML.
  // The SECRET is what verifies a token server-side and must never be served.
  const res = await onRequestGet({ env: { TURNSTILE_SITE_KEY: ' 0xSITE ', TURNSTILE_SECRET_KEY: '0xSECRET' } });
  const body = await res.json();
  assert.equal(body.siteKey, '0xSITE', 'trimmed, because an env var picks up whitespace');
  assert.equal(body.required, true);
  assert.doesNotMatch(JSON.stringify(body), /0xSECRET/, 'the secret must never be served to a browser');
});

test('an unconfigured deployment reports the check as off, not broken', async () => {
  const body = await (await onRequestGet({ env: {} })).json();
  assert.deepEqual(body, { ok: true, required: false, siteKey: null });
});

test('secret-without-site-key is reported, because it rejects every signup', async () => {
  // The one configuration that silently breaks the form: the server enforces
  // Turnstile, the page has no key to render a widget with, so every submit is
  // a 403. Reporting required-without-a-key is what lets the form say so on
  // load instead of one failed signup at a time.
  const body = await (await onRequestGet({ env: { TURNSTILE_SECRET_KEY: 'k' } })).json();
  assert.equal(body.required, true);
  assert.equal(body.siteKey, null);

  const js = read('assets/newsletter.js');
  assert.match(js, /if \(turnstile\.required\) \{/);
  assert.match(js, /misconfigured/, 'the form must say so rather than failing silently');
  // A used token is single-use; a retry with the same one always fails.
  assert.match(js, /delete form\.dataset\.turnstileToken;/);
  assert.match(js, /window\.turnstile\.reset\(\)/);
});

test('the widget is on the signup forms and never on the unsubscribe form', () => {
  // Making it harder to leave a list than to join one is exactly what the
  // opt-out design is against, so no bot check ever guards an unsubscribe.
  for (const page of ['index.html', 'prop-firms.html']) {
    assert.match(read(page), /class="nl-turnstile"/, `${page} needs a widget slot`);
  }
  assert.doesNotMatch(read('unsubscribe.html'), /nl-turnstile/);
  assert.match(read('assets/newsletter.js'), /form\.nl-signup'\)\.forEach\(initSignup\)/);
  // The slot collapses while the feature is off, so it costs no layout.
  assert.match(read('assets/newsletter.css'), /\.nl-turnstile:empty \{ display: none; \}/);
  // The CSP already allows the challenge origin, or the widget could not load.
  const headers = read('_headers');
  assert.match(headers, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(headers, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
});
