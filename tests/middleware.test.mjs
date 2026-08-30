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

console.log('# VJM middleware (gated-content) tests passed.');
