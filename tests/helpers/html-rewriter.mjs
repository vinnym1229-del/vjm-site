// A minimal HTMLRewriter test double, shared by every test that drives
// functions/_middleware.js.
//
// Node has no global HTMLRewriter — it is a Workers-runtime API — so without
// this the middleware throws ReferenceError the moment it reaches the strip,
// and any test of the code AROUND the strip silently cannot run. It supports
// exactly what the middleware uses: `.on('.class', handler)` plus
// `.transform(response)`, matching by class token and preserving nesting depth
// by tag name. It is not a general CSS engine.
//
// Importing this module installs it on globalThis, which is why it lives in
// one place: two divergent doubles would let a test pass against a rewriter
// that behaves differently from the one the other tests use.

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

export { TestHTMLRewriter, rewriteHtml };
