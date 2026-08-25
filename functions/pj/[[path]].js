// Cloudflare Pages Function: live-proxies /pj/* on the production domain to
// the `pj` branch's own Cloudflare Pages deployment. This replaces the old
// hand-synced static /pj/ folder, which went stale every time anyone pushed
// to pj and nobody remembered to re-copy the files. Nothing to sync anymore —
// this always reflects whatever is currently live on pj.vjm.pages.dev.
//
// Note: pj's pages call absolute API paths like /api/content — those still
// hit THIS project's own /api/* Functions (main's), not pj's. That was already
// true of the old static copy; this proxy doesn't change that behavior.

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
  headers.set('X-Robots-Tag', 'noindex, follow');

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    const loc = headers.get('location');
    if (loc) {
      const locUrl = new URL(loc, UPSTREAM_ORIGIN);
      if (locUrl.origin === UPSTREAM_ORIGIN) {
        headers.set('location', '/pj' + locUrl.pathname + locUrl.search);
      }
    }
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
