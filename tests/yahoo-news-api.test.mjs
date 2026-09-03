// Regression coverage for /api/yahoo-news (functions/api/yahoo-news.js).
//
// This was the last of the two probe-targeted endpoints (the run cycle's own
// live-deployment check hits it by curl, GET /api/yahoo-news?symbol=AAPL)
// with zero test references -- stock-research.js, the other one, already
// has tests/stock-research-api.test.mjs. Pins: missing symbol/topic rejected
// before any upstream call, the closed topic allowlist (forex-calendar.html
// depends on ?topic=forex resolving, and an unknown topic must 400 rather
// than fall through to a caller-controlled query), the mojibake repair for
// double-encoded UTF-8 titles, the https-only link sanitizer (a javascript:
// or http: link must be dropped, not passed through), and dedup-by-link.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/yahoo-news.js';

let ipCounter = 0;
async function fetchNews(query) {
  ipCounter += 1;
  const res = await onRequestGet({
    request: new Request(`https://example.com/api/yahoo-news${query}`, {
      headers: { 'CF-Connecting-IP': `10.3.0.${ipCounter}` },
    }),
    env: {},
  });
  return { status: res.status, data: await res.json() };
}

// The 30/min rate-limit guard (keyed by scope+ip only, no symbol) is the
// first thing onRequestGet does -- it must trip before the 31st request
// from one IP ever reaches Yahoo, this route's own third-party call.
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ news: [] }); };
  try {
    const ip = '10.8.0.1';
    const req = () => onRequestGet({
      request: new Request('https://example.com/api/yahoo-news?symbol=AAPL', {
        headers: { 'CF-Connecting-IP': ip },
      }),
      env: {},
    });
    for (let i = 0; i < 30; i++) await req();
    assert.equal(calls, 30);
    const limited = await req();
    assert.equal(limited.status, 429);
    const limitedData = await limited.json();
    assert.equal(limitedData.ok, false);
    assert.equal(calls, 30, 'the limited request must never reach Yahoo');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Neither a symbol nor a recognized topic: rejected before any upstream call.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Yahoo with no symbol or topic'); };
  try {
    const { status, data } = await fetchNews('');
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Unknown topic is not a caller-controlled passthrough -- the allowlist is
// closed, so a topic outside it must 400 exactly like no topic at all.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Yahoo with an unlisted topic'); };
  try {
    const { status, data } = await fetchNews('?topic=nonexistent');
    assert.equal(status, 400);
    assert.equal(data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalFetch = globalThis.fetch;
try {
  // Recognized topic resolves through the fixed allowlist query, and a
  // mojibake-corrupted title is repaired. The repair only fires for the
  // 2-byte UTF-8 case it guards on (a Latin-1 Supplement char re-decoded as
  // Latin-1 leaves a "Â"/"Ã" + continuation-byte pair, e.g. cafÃ© for café);
  // build that the same way Yahoo's double-encoding would rather than
  // hand-typing the escaped chars.
  {
    const correctTitle = 'café-fueled market open';
    const mojibakeTitle = Array.from(Buffer.from(correctTitle, 'utf8'))
      .map((b) => String.fromCharCode(b)).join('');
    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return Response.json({
        news: [{
          title: mojibakeTitle,
          link: 'https://finance.yahoo.com/news/a',
          publisher: 'Reuters',
          providerPublishTime: 1735689600,
        }],
      });
    };
    const { status, data } = await fetchNews('?topic=forex');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.topic, 'forex');
    assert.ok(capturedUrl.includes(encodeURIComponent('EURUSD=X')), 'topic must resolve to its mapped query, not the raw topic string');
    assert.equal(data.items[0].title, correctTitle);
  }

  // Case-insensitive topic match.
  {
    globalThis.fetch = async () => Response.json({ news: [] });
    const { status, data } = await fetchNews('?topic=FOREX');
    assert.equal(status, 200);
    assert.equal(data.topic, 'forex');
  }

  // A non-https link (or javascript:) must be dropped, and an item with no
  // survivable link must not appear at all rather than rendering a dead link.
  {
    globalThis.fetch = async () => Response.json({
      news: [
        { title: 'Safe item', link: 'https://finance.yahoo.com/news/b', providerPublishTime: 1735689600 },
        { title: 'Unsafe item', link: 'javascript:alert(1)', providerPublishTime: 1735689600 },
      ],
    });
    const { status, data } = await fetchNews('?symbol=AAPL');
    assert.equal(status, 200);
    assert.equal(data.count, 1);
    assert.equal(data.items[0].title, 'Safe item');
  }

  // Duplicate links (same story surfaced twice) are deduped.
  {
    globalThis.fetch = async () => Response.json({
      news: [
        { title: 'Story A', link: 'https://finance.yahoo.com/news/c', providerPublishTime: 1735689600 },
        { title: 'Story A repost', link: 'https://finance.yahoo.com/news/c', providerPublishTime: 1735689700 },
      ],
    });
    const { status, data } = await fetchNews('?symbol=AAPL');
    assert.equal(status, 200);
    assert.equal(data.count, 1);
  }

  // Upstream failure surfaces as the generic unavailable message, not a leak,
  // and never fabricates items.
  {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });
    const { status, data } = await fetchNews('?symbol=AAPL');
    assert.equal(status, 502);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'News feed is temporarily unavailable.');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('VJM yahoo-news API tests passed.');
