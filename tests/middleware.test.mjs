// Regression coverage for functions/_middleware.js — the server-side gate
// that strips paid lesson markup from the four course pages before it ever
// reaches a browser. This is the actual enforcement point for the site's
// core invariant (tests/regressions.test.mjs: only futures-dissection Level 1
// and the psychology essay are free; every other level is gated), but until
// now the only coverage was a textual/regex check that the source *mentions*
// getSession/HTMLRewriter/.gated-content — nothing ever exercised onRequest()
// and confirmed a real unauthenticated request actually comes back stripped.
//
// Node has no global HTMLRewriter (that's a Workers-runtime API), so this
// file installs a minimal test double that supports exactly what the
// middleware uses: `.on('.class', handler)` + `.transform(response)`,
// matching by class token and preserving nesting depth by tag name. It is
// not a general CSS engine — just enough to prove the real rewrite happens.
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';
import { signSession } from '../functions/api/_lib/session.js';
import { TIERS, SESSION_VERSION } from '../functions/api/_lib/entitlements.js';

const SECRET = 'x'.repeat(32);

// ---------------------------------------------------------------------------
// Minimal HTMLRewriter test double (see file header for scope).
// ---------------------------------------------------------------------------
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TAG_RE = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*?)?\/?>|[^<]+/gi;

function tagName(tag) {
  const m = tag.match(/^<\/?\s*([a-zA-Z0-9-]+)/);
  return m ? m[1].toLowerCase() : null;
}
function classesOf(tag) {
  const m = tag.match(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/i);
  return (m ? (m[2] ?? m[3] ?? '') : '').split(/\s+/).filter(Boolean);
}
function isSelfClosing(tag) {
  return /\/>\s*$/.test(tag) || VOID_ELEMENTS.has(tagName(tag));
}
function setAttrOnTag(tag, name, value) {
  const insertion = ` ${name}="${value}"`;
  return /\/>\s*$/.test(tag) ? tag.replace(/\/>\s*$/, insertion + ' />') : tag.replace(/>\s*$/, insertion + '>');
}

function rewriteHtml(html, handlers) {
  const classHandlers = handlers.filter((h) => h.selector.startsWith('.')).map((h) => ({ cls: h.selector.slice(1), handler: h.handler }));
  const tokens = html.match(TAG_RE) || [];
  let result = '';
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const opensElement = tok.startsWith('<') && !tok.startsWith('</') && !tok.startsWith('<!');
    const match = opensElement && classHandlers.find((h) => classesOf(tok).includes(h.cls));
    if (match && !isSelfClosing(tok)) {
      const name = tagName(tok);
      let depth = 1;
      let j = i + 1;
      let inner = '';
      while (j < tokens.length && depth > 0) {
        const t2 = tokens[j];
        if (t2.startsWith(`<${name}`) && !t2.startsWith('</') && tagName(t2) === name) {
          if (!isSelfClosing(t2)) depth++;
          inner += t2;
        } else if (t2.startsWith(`</${name}`) && tagName(t2) === name) {
          depth -= 1;
          if (depth === 0) { j += 1; break; }
          inner += t2;
        } else {
          inner += t2;
        }
        j += 1;
      }
      const attrs = {};
      const el = { setInnerContent(v) { this._inner = v; }, setAttribute(n, v) { attrs[n] = v; } };
      match.handler.element(el);
      let openTag = tok;
      for (const [n, v] of Object.entries(attrs)) openTag = setAttrOnTag(openTag, n, v);
      result += openTag + (el._inner !== undefined ? el._inner : inner) + `</${name}>`;
      i = j;
      continue;
    }
    result += tok;
    i += 1;
  }
  return result;
}

class TestHTMLRewriter {
  constructor() { this._handlers = []; }
  on(selector, handler) { this._handlers.push({ selector, handler }); return this; }
  async transform(response) {
    const body = await response.text();
    return new Response(rewriteHtml(body, this._handlers), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
globalThis.HTMLRewriter = TestHTMLRewriter;

// ---------------------------------------------------------------------------
// Fixture: a stand-in for a real course page (see futures-dissection.html
// for the real structure this mirrors).
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html><html><body>
<h1>Course</h1>
<div class="gated-content" hidden><details class="lesson-card"><p>paid lesson text</p></details></div>
<div class="free-content"><p>free teaser</p></div>
</body></html>`;

function gatedPageResponse({ status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return new Response(PAGE_HTML, { status, headers: { 'content-type': contentType, 'content-length': String(PAGE_HTML.length), etag: '"abc"' } });
}

function run(path, { method = 'GET', cookie, env = {}, nextResponse } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  const request = new Request(`https://example.com${path}`, { method, headers });
  const calledNext = { count: 0 };
  const context = {
    request,
    env,
    next: async () => { calledNext.count += 1; return nextResponse ?? gatedPageResponse(); },
  };
  return { context, calledNext, promise: onRequest(context) };
}

async function sessionCookie() {
  const token = await signSession({ exp: Date.now() + 60000 }, SECRET);
  return `__Host-vjm_session=${token}`;
}

// A tier-carrying (v2) session cookie, the shape every mint now produces.
async function tieredCookie(tier) {
  const token = await signSession(
    { v: SESSION_VERSION, mr: 'ab12', dn: '', t: tier, exp: Date.now() + 60000 }, SECRET,
  );
  return `__Host-vjm_session=${token}`;
}

// Does this response still contain the paid lesson body?
async function unlocked(path, opts) {
  const { promise } = run(path, opts);
  const body = await (await promise).text();
  return body.includes('paid lesson text');
}

// Unauthenticated GET to a gated course page: paid content never reaches the
// response body, but the wrapper element and its sibling free content survive.
{
  const { promise } = run('/futures-dissection', {});
  const res = await promise;
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes('paid lesson text'), 'paid lesson text leaked to an unauthenticated request');
  assert.ok(body.includes('free teaser'), 'unrelated free content was wrongly touched');
  assert.match(body, /data-locked="1"/, 'stripped wrapper must be marked locked');
}

// Authenticated GET (valid signed session) gets the full, untouched lesson.
{
  const cookie = await sessionCookie();
  const { promise } = run('/futures-dissection', { env: { SESSION_SIGNING_SECRET: SECRET }, cookie });
  const res = await promise;
  const body = await res.text();
  assert.ok(body.includes('paid lesson text'), 'authenticated member was denied their own paid content');
}

// A garbage/tampered cookie must fail closed to the unauthenticated (stripped)
// path, not throw and not fall through to the authenticated branch.
{
  const { promise } = run('/futures-dissection', { env: { SESSION_SIGNING_SECRET: SECRET }, cookie: '__Host-vjm_session=not.avalidtoken' });
  const res = await promise;
  const body = await res.text();
  assert.ok(!body.includes('paid lesson text'), 'a tampered session cookie must not unlock gated content');
}

// Both branches (stripped and full) must carry the same no-store contract —
// this response body depends on the caller's own session, so neither variant
// may be reused by a shared/edge cache for a different visitor.
{
  const { promise } = run('/futures-dissection', {});
  const res = await promise;
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('content-length'), null, 'stale content-length from the pre-rewrite body must not survive');
  assert.equal(res.headers.get('etag'), null, 'stale etag from the pre-rewrite body must not survive');
}
{
  const cookie = await sessionCookie();
  const { promise } = run('/futures-dissection', { env: { SESSION_SIGNING_SECRET: SECRET }, cookie });
  const res = await promise;
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
}

// Non-GET requests to a gated path (and non-gated GET paths) are pure
// passthrough: onRequest never touches getSession or HTMLRewriter, it just
// hands back context.next()'s own response, untouched.
{
  const nextResponse = new Response('posted', { status: 201 });
  const { promise, calledNext } = run('/futures-dissection', { method: 'POST', nextResponse });
  const res = await promise;
  assert.equal(res, nextResponse, 'a non-GET request must be an identity passthrough, not rebuilt');
  assert.equal(calledNext.count, 1);
}
{
  const nextResponse = new Response('<html>home</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const { promise } = run('/index.html', { nextResponse });
  const res = await promise;
  assert.equal(res, nextResponse, 'an ungated page must be an identity passthrough, not rebuilt');
}

// A non-2xx or non-HTML response from the origin (e.g. a 404, or a
// content-type this middleware has no business rewriting) is also passthrough.
{
  const nextResponse = gatedPageResponse({ status: 404 });
  const { promise } = run('/futures-dissection', { nextResponse });
  const res = await promise;
  assert.equal(res, nextResponse);
}
{
  const nextResponse = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const { promise } = run('/futures-dissection', { nextResponse });
  const res = await promise;
  assert.equal(res, nextResponse);
}

// Spot-check the other three gated pages (both route forms) actually strip —
// regressions.test.mjs already pins that the source text mentions each path;
// this confirms the behavior for two of them end-to-end rather than by name.
for (const path of ['/psychology-enhancer', '/options-lab.html']) {
  const { promise } = run(path, {});
  const res = await promise;
  const body = await res.text();
  assert.ok(!body.includes('paid lesson text'), `${path}: paid content was not stripped`);
}

// ---------------------------------------------------------------------------
// The entitlement matrix, through the REAL middleware.
//
// This is the bug the whole change exists for: the gate used to be
// `!!getSession(...)`, so ANY valid session unlocked ALL four courses and a
// $100 Futures Only buyer silently received the $129 Complete library. These
// assertions are what make the two products actually different products —
// if the middleware ever goes back to a boolean session check, the two
// Complete-only rows below unlock and fail.
// ---------------------------------------------------------------------------
const CORE_PAGES = ['/futures-dissection', '/futures-dissection.html', '/psychology-enhancer', '/psychology-enhancer.html'];
const COMPLETE_PAGES = ['/stock-breakdown', '/stock-breakdown.html', '/options-lab', '/options-lab.html'];
const TIER_ENV = { SESSION_SIGNING_SECRET: SECRET };

// $100 Futures Only: the futures track and the psychology material it
// depends on — and nothing from the Complete-only library.
{
  const cookie = await tieredCookie(TIERS.FUTURES_CORE);
  for (const path of CORE_PAGES) {
    assert.equal(await unlocked(path, { env: TIER_ENV, cookie }), true,
      `${path}: a futures_core member was denied content they paid for`);
  }
  for (const path of COMPLETE_PAGES) {
    assert.equal(await unlocked(path, { env: TIER_ENV, cookie }), false,
      `${path}: a $100 futures_core member received Complete-only content`);
  }
}

// $129 Complete: everything, because Complete outranks Core.
{
  const cookie = await tieredCookie(TIERS.COMPLETE);
  for (const path of [...CORE_PAGES, ...COMPLETE_PAGES]) {
    assert.equal(await unlocked(path, { env: TIER_ENV, cookie }), true,
      `${path}: a $129 complete member was denied content they paid for`);
  }
}

// No session at all: nothing gated, on any of the four courses.
for (const path of [...CORE_PAGES, ...COMPLETE_PAGES]) {
  assert.equal(await unlocked(path, { env: TIER_ENV }), false,
    `${path}: an anonymous visitor received paid content`);
}

// A denied under-tier member must be indistinguishable from an anonymous
// visitor: the same stripped page, same locked marker, same free teaser —
// not an error, not a redirect, not a partial reveal.
{
  const cookie = await tieredCookie(TIERS.FUTURES_CORE);
  const { promise } = run('/options-lab', { env: TIER_ENV, cookie });
  const res = await promise;
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /data-locked="1"/, 'an under-tier member must get the same locked page an anonymous visitor gets');
  assert.ok(body.includes('free teaser'), 'the free content must still render for an under-tier member');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store',
    'a tier-dependent body must never be cached for another visitor');
}

// A tier that is not one of ours is not a tier: a forged or renamed claim
// falls back to the legacy path, and under STRICT_LEGACY_SESSIONS it is
// simply denied. Either way it must not out-rank complete.
{
  const cookie = await tieredCookie('superuser');
  assert.equal(
    await unlocked('/options-lab', { env: { ...TIER_ENV, STRICT_LEGACY_SESSIONS: 'true' }, cookie }), false,
    'an invented tier name must not unlock Complete-only content',
  );
}

// Pre-tier (v1) tokens are grandfathered so shipping this does not sign out
// every live member mid-session…
{
  const token = await signSession({ v: 1, mr: 'ab12', dn: '', exp: Date.now() + 60000 }, SECRET);
  const cookie = `__Host-vjm_session=${token}`;
  assert.equal(await unlocked('/options-lab', { env: TIER_ENV, cookie }), true,
    'an existing v1 session must keep working until it expires on its own');

  // …and the owner can close that window in one env var, forcing everyone to
  // re-authenticate once and pick up a real tier claim.
  assert.equal(
    await unlocked('/options-lab', { env: { ...TIER_ENV, STRICT_LEGACY_SESSIONS: 'true' }, cookie }), false,
    'STRICT_LEGACY_SESSIONS=true must cut off untiered legacy sessions',
  );
  assert.equal(
    await unlocked('/futures-dissection', { env: { ...TIER_ENV, STRICT_LEGACY_SESSIONS: 'true' }, cookie }), false,
    'strict mode cuts legacy sessions off from every gated course, not just the Complete ones',
  );
}

// Tampering with a tiered cookie's payload (swapping futures_core for
// complete) breaks the HMAC, so it fails closed to the stripped page rather
// than being read as a self-declared upgrade.
{
  const token = await signSession(
    { v: SESSION_VERSION, mr: 'ab12', dn: '', t: TIERS.FUTURES_CORE, exp: Date.now() + 60000 }, SECRET,
  );
  const [payload, sig] = token.split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
  forged.t = TIERS.COMPLETE;
  const forgedToken = Buffer.from(JSON.stringify(forged)).toString('base64url') + '.' + sig;
  assert.equal(
    await unlocked('/options-lab', { env: TIER_ENV, cookie: `__Host-vjm_session=${forgedToken}` }), false,
    'a self-upgraded tier claim must not verify — the tier is a SIGNED claim',
  );
}

console.log('# VJM middleware (gated-content + tier) tests passed.');
