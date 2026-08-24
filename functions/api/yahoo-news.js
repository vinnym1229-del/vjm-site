// Cloudflare Pages Function: GET /api/yahoo-news?symbol=TSLA
//
// Company headlines from Yahoo Finance's public RSS feed. Hardened:
// - strict symbol validation, host allowlist, no open URL construction
// - titles/links sanitized and length-capped; deduped by link
// - cached ~5 min; explicit unavailable state on failure (no fake items)

import { json, cleanSymbol } from './_lib/http.js';

const FEED_HOST = 'feeds.finance.yahoo.com';
const MAX_ITEMS = 12;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));

  if (!symbol) {
    return json({ ok: false, error: 'Provide a valid ticker symbol.' }, 400);
  }

  const feedUrl = `https://${FEED_HOST}/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;

  try {
    const res = await fetch(feedUrl, {
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('upstream status ' + res.status);
    const xml = await res.text();
    const items = parseRss(xml)
      .filter((it) => it.title && it.link && /^https:\/\//i.test(it.link))
      // Only pass through yahoo/finance-hosted links or any https link from
      // the feed itself — the feed is publisher-controlled; we sanitize
      // rather than allowlist individual publishers.
      .map((it) => ({
        title: sanitizeText(it.title, 200),
        link: sanitizeLink(it.link),
        publisher: sanitizeText(it.publisher || 'Yahoo Finance', 80),
        pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null,
        description: it.description ? sanitizeText(stripTags(it.description), 240) : '',
      }))
      .filter((it) => it.title && it.link);

    const seen = new Set();
    const deduped = items.filter((it) => {
      if (seen.has(it.link)) return false;
      seen.add(it.link);
      return true;
    }).slice(0, MAX_ITEMS);

    return json({
      ok: true,
      symbol,
      source: { name: 'Yahoo Finance RSS', url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/news` },
      mode: 'observed',
      fetchedAt: new Date().toISOString(),
      cached: false,
      count: deduped.length,
      items: deduped,
    });
  } catch (err) {
    return json({
      ok: false,
      error: 'News feed is temporarily unavailable.',
      symbol,
      detail: String(err && err.message || err).slice(0, 160),
    }, 502);
  }
}

function parseRss(xml) {
  const out = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && out.length < MAX_ITEMS * 3) {
    const block = m[0];
    out.push({
      title: pickTag(block, 'title'),
      link: pickTag(block, 'link'),
      pubDate: pickTag(block, 'pubDate'),
      description: pickTag(block, 'description'),
      publisher: 'Yahoo Finance',
    });
  }
  return out;
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  // Decode common XML entities; leave other text for client-side escaping.
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

function sanitizeText(s, max) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, max);
}

function sanitizeLink(link) {
  try {
    const u = new URL(String(link));
    if (u.protocol !== 'https:') return '';
    return u.toString().slice(0, 600);
  } catch {
    return '';
  }
}
