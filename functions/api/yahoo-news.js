// Cloudflare Pages Function: GET /api/yahoo-news?symbol=TSLA
//                       or:  GET /api/yahoo-news?topic=forex
//
// Headlines from Yahoo Finance. Hardened:
// - strict symbol validation, single allowlisted host, no caller-built URLs
// - titles/links sanitized and length-capped; deduped by link
// - cached ~5 min; explicit unavailable state on failure (no fake items)
//
// Source note: this used to read feeds.finance.yahoo.com/rss/2.0/headline.
// Yahoo has since retired that path -- it now answers 404 to a direct fetch
// and 429 through Cloudflare's egress, so the route returned "temporarily
// unavailable" on every single call and both callers (stock-lab's news reel
// and the forex calendar's headline panel) sat permanently empty. Swapped to
// the JSON search endpoint, which is live and returns structured items.

import { json, cleanSymbol, checkRateLimit } from './_lib/http.js';

const API_HOST = 'query1.finance.yahoo.com';
const MAX_ITEMS = 12;

// forex-calendar.html has always called this route with ?topic=forex, which
// the symbol-only contract rejected with a 400. Topics map to a fixed query
// through a closed allowlist, so no caller can steer the upstream request.
const TOPICS = {
  forex: { query: 'EURUSD=X', label: 'Forex' },
  futures: { query: 'ES=F', label: 'Index futures' },
  market: { query: 'SPY', label: 'US market' },
};

export async function onRequestGet(context) {
  // Abuse guard: this route calls a third party.
  const _rl = await checkRateLimit(context.env, context.request, 'yahoo-news', 30);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);

  const url = new URL(context.request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  const topicKey = String(url.searchParams.get('topic') || '').toLowerCase();
  const topic = Object.prototype.hasOwnProperty.call(TOPICS, topicKey) ? TOPICS[topicKey] : null;

  if (!symbol && !topic) {
    return json({ ok: false, error: 'Provide a valid ticker symbol or topic.' }, 400);
  }

  const query = topic ? topic.query : symbol;
  const feedUrl = `https://${API_HOST}/v1/finance/search`
    + `?q=${encodeURIComponent(query)}&newsCount=${MAX_ITEMS}&quotesCount=0&enableFuzzyQuery=false`;

  try {
    const res = await fetch(feedUrl, {
      headers: {
        // Yahoo rejects requests without a browser-ish UA.
        'User-Agent': 'Mozilla/5.0 (compatible; PJTradesBot/1.0)',
        Accept: 'application/json',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('upstream status ' + res.status);

    const data = await res.json();
    const raw = Array.isArray(data && data.news) ? data.news : [];

    const items = raw
      .map((it) => ({
        title: sanitizeText(fixMojibake(it.title), 200),
        link: sanitizeLink(it.link),
        publisher: sanitizeText(fixMojibake(it.publisher) || 'Yahoo Finance', 80),
        // providerPublishTime is unix seconds.
        pubDate: Number.isFinite(Number(it.providerPublishTime))
          ? new Date(Number(it.providerPublishTime) * 1000).toISOString()
          : null,
        description: '',
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
      symbol: symbol || null,
      topic: topic ? topicKey : null,
      source: {
        name: 'Yahoo Finance',
        url: topic ? 'https://finance.yahoo.com/news/' : `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/news`,
      },
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
      symbol: symbol || null,
      topic: topic ? topicKey : null,
      detail: String((err && err.message) || err).slice(0, 160),
    }, 502);
  }
}

// Yahoo occasionally double-encodes UTF-8 in these titles, so a curly
// apostrophe arrives as "â€™". Repair only when that exact pattern shows up;
// leaving it produces visible garbage in the headline.
function fixMojibake(s) {
  const str = String(s == null ? '' : s);
  if (!/[\u00C2-\u00C3][\u0080-\u00BF]/.test(str)) return str;
  try {
    const bytes = Uint8Array.from([...str].map((c) => c.charCodeAt(0) & 0xff));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return str;
  }
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
