// Who is allowed into a search index, and who is not.
//
// This replaced a manual switch — a human deleting one line in `_headers` at
// exactly the right moment — with a per-request decision. That is only an
// improvement if it fails in the right direction, so most of what is pinned
// here is the failure behaviour, not the happy path: an unknown host, a
// missing header, a thrown error and an unset env must all end in "not
// indexed", because an indexed *.pages.dev host is much harder to undo than a
// launch that happens a day late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_HOST, ALWAYS_NOINDEX, isIndexable, isCanonicalHost,
  isAlwaysNoindex, normalizeHost,
} from '../functions/api/_lib/indexing.js';
import './helpers/html-rewriter.mjs';
import { onRequest } from '../functions/_middleware.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const req = (url, host) => new Request(url, { headers: host ? { host } : {} });

test('only the canonical host and its www. form are indexable', () => {
  for (const host of [CANONICAL_HOST, `www.${CANONICAL_HOST}`, CANONICAL_HOST.toUpperCase(), `${CANONICAL_HOST}:443`]) {
    assert.equal(isCanonicalHost(host, {}), true, `${host} should be canonical`);
  }
  for (const host of [
    'pj.vjm.pages.dev', 'vjm-site.pages.dev', 'abc123.vjm.pages.dev',
    'notfinancialadvicevjm.com',                       // the un-hyphenated variant
    `${CANONICAL_HOST}.evil.com`, `evil.com/${CANONICAL_HOST}`,
    'localhost', '', null, undefined,
  ]) {
    assert.equal(isCanonicalHost(host, {}), false, `${host} must not be treated as canonical`);
  }
});

test('a preview deployment is never indexable, whatever the path', () => {
  for (const path of ['/', '/index.html', '/prop-firms.html', '/futures-dissection']) {
    assert.equal(isIndexable(req(`https://pj.vjm.pages.dev${path}`, 'pj.vjm.pages.dev'), {}), false);
  }
});

test('the real host indexes public pages and still excludes the private ones', () => {
  const on = (path) => isIndexable(req(`https://${CANONICAL_HOST}${path}`, CANONICAL_HOST), {});
  for (const path of ['/', '/index.html', '/prop-firms.html', '/premarket.html', '/privacy.html']) {
    assert.equal(on(path), true, `${path} should be indexable on the real domain`);
  }
  // Member tools, the API, the preview copies and the opt-out page never are.
  for (const path of [
    '/api/newsletter/subscribe', '/video/pj-intro.mp4', '/pj/index.html',
    '/stock-lab', '/stock-lab.html', '/research-engine', '/research-engine.html',
    '/premium-guidance', '/premium-guidance.html', '/unsubscribe', '/unsubscribe.html',
  ]) {
    assert.equal(on(path), false, `${path} must never be indexed`);
  }
  assert.equal(isAlwaysNoindex('/STOCK-LAB.HTML'), true, 'the path check is case-insensitive');
});

test('the env kill switch puts the whole site back behind a hold', () => {
  const r = req(`https://${CANONICAL_HOST}/`, CANONICAL_HOST);
  assert.equal(isIndexable(r, {}), true, 'unset means the host decides');
  assert.equal(isIndexable(r, { INDEXING: 'on' }), true);
  assert.equal(isIndexable(r, { INDEXING: 'off' }), false);
  assert.equal(isIndexable(r, { INDEXING: 'hold' }), false, 'anything but "on" holds');
  assert.equal(isIndexable(r, { INDEXING: '  ' }), true, 'whitespace is not a value');
  // The canonical host is overridable, for a domain change without a code edit.
  assert.equal(isIndexable(req('https://example.com/', 'example.com'), { CANONICAL_HOST: 'example.com' }), true);
  assert.equal(isIndexable(r, { CANONICAL_HOST: 'example.com' }), false);
});

test('the middleware only ever REMOVES the header, never adds one', async () => {
  // The whole safety argument rests on this. If the middleware could add a
  // noindex it could also add the wrong one; because it can only delete, the
  // worst a bug here does is leave the site unindexed.
  const html = (extra = {}) => new Response('<html><body>hi</body></html>', {
    headers: { 'content-type': 'text/html', ...extra },
  });

  // Canonical host + indexable path + the header present → stripped.
  let out = await onRequest({
    request: req(`https://${CANONICAL_HOST}/index.html`, CANONICAL_HOST),
    env: {},
    next: async () => html({ 'X-Robots-Tag': 'noindex' }),
  });
  assert.equal(out.headers.get('X-Robots-Tag'), null);
  assert.equal(await out.text(), '<html><body>hi</body></html>', 'the body is untouched');

  // Preview host → the header survives.
  out = await onRequest({
    request: req('https://pj.vjm.pages.dev/index.html', 'pj.vjm.pages.dev'),
    env: {},
    next: async () => html({ 'X-Robots-Tag': 'noindex' }),
  });
  assert.equal(out.headers.get('X-Robots-Tag'), 'noindex');

  // No header to strip → the response is passed through untouched.
  const passthrough = html();
  out = await onRequest({
    request: req(`https://${CANONICAL_HOST}/index.html`, CANONICAL_HOST),
    env: {},
    next: async () => passthrough,
  });
  assert.equal(out, passthrough, 'no allocation when there is nothing to do');

  // A thrown error inside the decision leaves the header in place.
  const brokenReq = { url: 'not a url', method: 'GET', headers: new Headers() };
  out = await onRequest({
    request: brokenReq, env: {},
    next: async () => html({ 'X-Robots-Tag': 'noindex' }),
  });
  assert.equal(out.headers.get('X-Robots-Tag'), 'noindex', 'fail closed');
});

test('a gated course page is indexable, but only in its stripped form', async () => {
  // The public description of a paid course should rank; the lesson text the
  // middleware just removed should not. Both exits run through the same lift.
  const body = '<html><body><p>Public blurb</p><div class="gated-content">PAID</div></body></html>';
  const out = await onRequest({
    request: req(`https://${CANONICAL_HOST}/options-lab`, CANONICAL_HOST),
    env: {},
    next: async () => new Response(body, {
      headers: { 'content-type': 'text/html', 'X-Robots-Tag': 'noindex' },
    }),
  });
  assert.equal(out.headers.get('X-Robots-Tag'), null, 'the course page may be indexed');
  const text = await out.text();
  assert.ok(text.includes('Public blurb'));
  assert.ok(!text.includes('PAID'), 'the paid lesson text must not reach a crawler');
});

test('the canonical host agrees with robots.txt, the canonical links, and _headers', () => {
  // Three places declare the real origin and they must not drift: a mismatch
  // means either an unindexable site or an indexed preview, and neither
  // announces itself.
  const robots = read('robots.txt');
  const declared = /^#\s*canonical-origin:\s*https:\/\/(\S+)\s*$/m.exec(robots);
  assert.ok(declared, 'robots.txt must declare a canonical-origin');
  assert.equal(declared[1], CANONICAL_HOST, 'robots.txt and indexing.js disagree');
  assert.match(read('index.html'), new RegExp(`rel="canonical" href="https://${CANONICAL_HOST}`));

  // The default-deny is what makes the whole thing safe, so it must stay.
  const headers = read('_headers');
  assert.match(headers, /^\/\*\n(?:  .+\n)*  X-Robots-Tag: noindex$/m,
    '_headers must keep the blanket noindex — the middleware only removes it');

  // Every permanent exclusion in _headers must also be in ALWAYS_NOINDEX,
  // otherwise the middleware would happily lift the header off it.
  for (const m of headers.matchAll(/^\/(\S*)\n\s+X-Robots-Tag: noindex, nofollow$/gm)) {
    const path = `/${m[1]}`.replace(/\*$/, '').replace(/\.html$/, '');
    assert.equal(isAlwaysNoindex(path === '/' ? '/x' : path), true,
      `${path} is permanently noindex in _headers but the middleware would un-noindex it`);
  }
  assert.ok(ALWAYS_NOINDEX.length >= 7);
  assert.equal(normalizeHost('  EXAMPLE.com:8443 '), 'example.com');
});
