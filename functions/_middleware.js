// Cloudflare Pages Function: strips paid lesson content from the HTML
// response before it ever reaches a browser without a valid member session.
//
// The four course pages mark premium lessons with `.gated-content hidden`
// and reveal them client-side once /api/verify-premium confirms a session.
// That is a purely cosmetic gate: the full lesson text was always present
// in the raw HTML, so `curl` or view-source handed out every paid course
// for free with no session, no code, no payment. This middleware closes
// that by checking the session server-side and blanking the gated markup
// before the response leaves the edge, exactly the way the JSON APIs
// already gate themselves (see api/_lib/session.js).
//
// Having a session is NOT the same as being entitled to the page: the site
// sells $100 Futures Only and $129 Complete, so the check is
// authorizeResource(session, path, env) — the signed tier claim against the
// tier that path requires (see api/_lib/entitlements.js). An under-tier
// member takes exactly the same stripped path an anonymous visitor does, so
// a Futures buyer opening /options-lab sees the locked page rather than the
// Complete library they did not buy.
//
// Fail-closed: any error while reading the session is treated as
// unauthenticated, consistent with the rest of the auth code in this repo.

import { getSession } from './api/_lib/session.js';
import { authorizeResource } from './api/_lib/entitlements.js';
import { isIndexable } from './api/_lib/indexing.js';

const GATED_PAGES = new Set([
  '/stock-breakdown', '/stock-breakdown.html',
  '/options-lab', '/options-lab.html',
  '/futures-dissection', '/futures-dissection.html',
  '/psychology-enhancer', '/psychology-enhancer.html',
]);

class StripGatedContent {
  element(el) {
    el.setInnerContent('');
    el.setAttribute('data-locked', '1');
  }
}

/**
 * Lift the blanket `X-Robots-Tag: noindex` that `_headers` puts on every
 * response, but only for a request that is genuinely allowed into the index
 * (see api/_lib/indexing.js). This only ever REMOVES a header: if this
 * function is never reached, or throws, the noindex stands and the site simply
 * stays unindexed — which is the safe direction to fail in, because an indexed
 * *.pages.dev host is much harder to undo than a late launch.
 *
 * Returns the response unchanged unless there is actually something to strip,
 * so the common case costs one header read and no allocation.
 */
async function applyIndexing(maybeResponse, request, env) {
  // Awaited, not assumed. The real HTMLRewriter.transform() hands back a
  // Response synchronously because it streams, but nothing guarantees that of
  // every caller — the test double has to be async, since it reads the body to
  // rewrite it — and awaiting a plain Response costs a microtask and nothing
  // else. Assuming the synchronous shape here read `.headers` off a Promise.
  const response = await maybeResponse;
  let allowed = false;
  try {
    allowed = isIndexable(request, env);
  } catch {
    return response;
  }
  if (!allowed || !response.headers.has('X-Robots-Tag')) return response;

  const headers = new Headers(response.headers);
  headers.delete('X-Robots-Tag');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // A URL this cannot parse must not take the request down with it. This threw
  // before reaching any of the guards below, so a malformed request line was a
  // 500 for the whole site rather than a normally-served page; an unparseable
  // URL is also, by definition, not one of the gated paths.
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return applyIndexing(await context.next(), request, env);
  }

  if (request.method !== 'GET' || !GATED_PAGES.has(url.pathname)) {
    return applyIndexing(await context.next(), request, env);
  }

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/html')) {
    return response;
  }

  let authorized = false;
  try {
    const session = await getSession(request, env);
    authorized = authorizeResource(session, url.pathname, env).allowed;
  } catch {
    authorized = false;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  // Auth-dependent body: never let a shared/edge cache reuse one visitor's
  // response (gated or full) for a different visitor's session state.
  headers.set('Cache-Control', 'private, no-store');

  if (authorized) {
    return applyIndexing(new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }), request, env);
  }

  // The stripped copy is the one a crawler gets, which is correct: the course
  // pages should be indexed for their public description, never for the paid
  // lesson text the strip just removed.
  return applyIndexing(new HTMLRewriter()
    .on('.gated-content', new StripGatedContent())
    .transform(new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })), request, env);
}
