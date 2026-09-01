// Which responses search engines are allowed to index.
//
// This used to be a manual switch: `_headers` sent `X-Robots-Tag: noindex` on
// `/*`, and going live meant a human deleting that line at exactly the right
// moment — after confirming the custom domain was attached, and never before.
// Two ways that goes wrong, and both are expensive:
//
//   * Delete it too early and the *.pages.dev deployment gets indexed. Now the
//     preview host outranks the real one, and un-indexing a host is far slower
//     than indexing it.
//   * Never get around to deleting it and no page of the site can appear in a
//     search result at all, which is the state this site has been in.
//
// So the decision is made per request instead, from the Host header, and the
// site starts being indexed the moment it is actually served from its own
// domain. Nobody has to remember anything.
//
// FAIL-CLOSED, deliberately: `_headers` still sends noindex on everything, and
// the middleware only ever REMOVES that header — never adds one. If the
// middleware fails to run, is misconfigured, or this file throws, the site
// stays unindexed. The failure mode of a bug here is "not in Google yet",
// never "the preview host is in Google".

/** The one origin allowed to be indexed. Mirrors the canonical-origin line in
 *  robots.txt and the <link rel="canonical"> on every page; a test pins that
 *  those three agree, because a silent disagreement here means either an
 *  unindexable site or an indexed preview. */
export const CANONICAL_HOST = 'not-financial-advice-vjm.com';

/** Paths that must never be indexed on ANY host, including the real one:
 *  member tools, the research engine, premium guidance, the API and video
 *  routes, the /pj/* preview copies, and the unsubscribe page. Mirrors the
 *  per-path blocks at the bottom of `_headers` — kept in sync by a test. */
export const ALWAYS_NOINDEX = [
  '/api/', '/video/', '/pj/',
  '/stock-lab', '/research-engine', '/premium-guidance', '/unsubscribe',
];

/** Strip the port and case-fold. A Host header carries neither guarantee. */
export function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

/** The canonical host, or www. in front of it. Nothing else. */
export function isCanonicalHost(host, env) {
  const canonical = normalizeHost((env && env.CANONICAL_HOST) || CANONICAL_HOST);
  const h = normalizeHost(host);
  if (!h || !canonical) return false;
  return h === canonical || h === `www.${canonical}`;
}

/** True for a path that stays out of the index whatever host serves it. */
export function isAlwaysNoindex(pathname) {
  const p = String(pathname || '').toLowerCase();
  return ALWAYS_NOINDEX.some((prefix) => (
    prefix.endsWith('/') ? p.startsWith(prefix) : (p === prefix || p === `${prefix}.html`)
  ));
}

/**
 * Should this response be allowed into the index?
 *
 * The answer is only ever used to DELETE the blanket noindex header that
 * `_headers` already set, so "false" costs nothing and "true" is the only
 * answer that changes anything.
 */
export function isIndexable(request, env) {
  // An explicit kill switch, for putting the whole site back behind a hold
  // without a deploy. Any value but 'on' keeps the site unindexed.
  const flag = env && env.INDEXING;
  if (typeof flag === 'string' && flag.trim() && flag.trim().toLowerCase() !== 'on') return false;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  // The Host header is what the visitor actually asked for; url.hostname can be
  // rewritten by intermediaries. Prefer the header, fall back to the URL.
  const host = normalizeHost(request.headers.get('host')) || normalizeHost(url.hostname);
  if (!isCanonicalHost(host, env)) return false;
  return !isAlwaysNoindex(url.pathname);
}
