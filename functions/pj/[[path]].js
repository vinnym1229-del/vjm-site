// Cloudflare Pages Function: live-proxies /pj/* on the production domain to
// the `pj` branch's own Cloudflare Pages deployment. This replaces the old
// hand-synced static /pj/ folder, which went stale every time anyone pushed
// to pj and nobody remembered to re-copy the files. Nothing to sync anymore —
// this always reflects whatever is currently live on pj.vjm.pages.dev.
//
// pj's pages write asset/link/fetch paths as if they own the domain root
// (e.g. src="assets/lightning-bg.js", fetch('/api/verify-premium')). Served
// raw under /pj, those resolve against THIS origin's root instead — assets
// 404 silently (confirmed: /assets/lightning-bg.js 404s here, so the
// sitewide lightning effect never loads at all under this proxy) and /api/
// calls hit main's own Functions instead of pj's (different bindings/code).
// HTML responses are rewritten (buffered -- these pages are well under a
// megabyte, streaming isn't worth the complexity) so every asset/link/fetch
// path stays scoped under /pj.
//
// Incident: that rewrite only ever touched the HTML document text, so any
// fetch('/api/...') sitting inside an EXTERNAL .js file (curriculum.js,
// chatbot.js, live-ticker.js, research-engine.js all have one) was never
// rewritten. On the real customer-facing domain that meant a root-relative
// fetch('/api/verify-premium') resolved against not-financial-advice-vjm.com
// itself -- a completely different site's Functions -- instead of pj's,
// so the premium unlock form, saved-session check, chatbot, live ticker,
// and research engine were all silently talking to the wrong backend and
// failing (confirmed live: not-financial-advice-vjm.com/api/verify-premium
// returned 400 "Missing token", a different app's error entirely). JS
// responses now go through the same fetch-path rewrite as HTML.

const UPSTREAM_ORIGIN = 'https://pj.vjm.pages.dev';

export async function onRequest(context) {
  const { request, params } = context;
  const url = new URL(request.url);
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const subPath = segments.map(encodeURIComponent).join('/');

  const upstreamUrl = new URL('/' + subPath, UPSTREAM_ORIGIN);
  upstreamUrl.search = url.search;

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch {
    return new Response('Preview temporarily unavailable.', { status: 502 });
  }

  const headers = new Headers(upstreamResponse.headers);
  // Indexing was force-blocked here while the site was still being hardened.
  // Each page already carries its own correct <meta name="robots"> (course
  // and marketing pages say index,follow; research-engine.html and 404.html
  // opt out on their own) — let that per-page decision stand instead of a
  // blanket override at the proxy. `pj` is a non-production branch, so
  // Cloudflare Pages itself force-injects X-Robots-Tag: noindex on every
  // pj.vjm.pages.dev response; strip that inherited header too, or it leaks
  // through onto the real customer-facing domain regardless of what this
  // proxy does or doesn't set.
  headers.delete('X-Robots-Tag');

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const loc = headers.get('location');
    if (loc) {
      const locUrl = new URL(loc, UPSTREAM_ORIGIN);
      if (locUrl.origin === UPSTREAM_ORIGIN) {
        headers.set('location', '/pj' + locUrl.pathname + locUrl.search);
      }
    }
  }

  const contentType = headers.get('content-type') || '';
  const isHtml = contentType.includes('text/html');
  const isJs = contentType.includes('javascript');
  if (!isHtml && !isJs) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const body = isHtml
    ? rewriteHtml(await upstreamResponse.text())
    : rewriteApiFetchCalls(await upstreamResponse.text());
  headers.delete('content-length');

  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

// Rewrites src=/href=/action= attribute values and fetch('/api/...' | '/video/...')
// call sites so they stay scoped under /pj. Skips absolute URLs (protocol or
// protocol-relative), data:/blob: URIs, in-page anchors, and anything already
// prefixed.
function rewriteHtml(html) {
  const attrPattern = /((?:src|href|action|srcset)\s*=\s*)(["'])([^"']+)\2/gi;
  html = html.replace(attrPattern, (full, prefix, quote, value) => {
    if (!shouldRewrite(value)) return full;
    return `${prefix}${quote}${prefixPath(value)}${quote}`;
  });

  // Inline style="background-image:url(...)" and any <style> block url(...).
  html = html.replace(/url\((['"]?)assets\//g, 'url($1/pj/assets/');

  return rewriteApiFetchCalls(html);
}

// fetch('/api/...'), fetch("/video/..."), template-literal variants. Shared
// between the HTML rewrite above and external .js assets (see incident note
// at the top of this file) — a fetch call reads the same whether it's typed
// inline in a <script> tag or sitting in a separately-served .js file.
function rewriteApiFetchCalls(text) {
  return text.replace(/(['"`])\/(api|video)\//g, '$1/pj/$2/');
}

function shouldRewrite(value) {
  if (!value) return false;
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return false;
  if (value.startsWith('/pj/')) return false;
  return true;
}

function prefixPath(value) {
  return value.startsWith('/') ? '/pj' + value : '/pj/' + value;
}
