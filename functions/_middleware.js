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
// Fail-closed: any error while reading the session is treated as
// unauthenticated, consistent with the rest of the auth code in this repo.

import { getSession } from './api/_lib/session.js';

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

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method !== 'GET' || !GATED_PAGES.has(url.pathname)) {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/html')) {
    return response;
  }

  let authorized = false;
  try {
    authorized = !!(await getSession(request, env));
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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new HTMLRewriter()
    .on('.gated-content', new StripGatedContent())
    .transform(new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }));
}
