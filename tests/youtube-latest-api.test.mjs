// Regression coverage for /api/youtube-latest (functions/api/youtube-latest.js).
//
// This is the same "no API key, degrade to null, never break the page"
// category as live-stats.js's Discord invite lookup: YouTube's public
// per-channel RSS feed needs no login or credential from the owner, only a
// correct YOUTUBE_CHANNEL_ID. Pins: the rate-limit guard trips before the
// upstream fetch, an unconfigured channel ID skips the fetch entirely (not
// attempted), a non-200 or throwing response degrades to video: null rather
// than surfacing an error, the first <entry> in the feed (already
// newest-first) is the one returned, its fields are extracted correctly
// including XML-entity-decoded titles, and the 15-minute edge-cache header.
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/youtube-latest.js';

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.5.0.${ipCounter}`;
}

async function call(env, ip) {
  const res = await onRequestGet({
    request: new Request('https://example.com/api/youtube-latest', {
      headers: { 'CF-Connecting-IP': ip },
    }),
    env,
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

function feedWith(videoId, title, published) {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">` +
    `<entry><yt:videoId>${videoId}</yt:videoId><title>${title}</title><published>${published}</published></entry>` +
    `<entry><yt:videoId>older123456</yt:videoId><title>Older video</title><published>2026-01-01T00:00:00+00:00</published></entry>` +
    `</feed>`;
}

// Rate limit trips before the upstream fetch (60/min) -- proven with a fetch
// that throws if reached at all, so a leaked call fails the test loudly.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call YouTube while rate-limit gating the request'); };
  try {
    const env = { YOUTUBE_CHANNEL_ID: 'UCabc' };
    const ip = nextIp();
    let last;
    for (let i = 0; i < 60; i++) last = await call(env, ip);
    assert.equal(last.status, 200);

    const limited = await call(env, ip);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const originalFetch = globalThis.fetch;
try {
  // Unconfigured: skipped entirely, not attempted -- the mock throws if
  // reached, so a dropped guard fails loudly rather than silently passing.
  {
    globalThis.fetch = async () => { throw new Error('must not fetch YouTube with no channel ID configured'); };
    const { status, data } = await call({}, nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.video, null);
  }

  // Configured and the feed resolves: shapes the first entry into the
  // fields the front-end card reads, decodes XML entities in the title,
  // and never touches the second (older) entry.
  {
    globalThis.fetch = async () => new Response(
      feedWith('newVid98765', 'Order Flow &amp; Risk — Live Recap', '2026-09-08T14:00:00+00:00'),
      { status: 200 },
    );
    const { status, headers, data } = await call({ YOUTUBE_CHANNEL_ID: 'UCabc' }, nextIp());
    assert.equal(status, 200);
    assert.deepEqual(data.video, {
      id: 'newVid98765',
      title: 'Order Flow & Risk — Live Recap',
      url: 'https://www.youtube.com/watch?v=newVid98765',
      thumbnail: 'https://i.ytimg.com/vi/newVid98765/hqdefault.jpg',
      publishedAt: '2026-09-08T14:00:00+00:00',
    });
    assert.match(headers.get('Cache-Control') || '', /max-age=900/);
  }

  // Upstream non-200: degrades to null, never surfaces an error.
  {
    globalThis.fetch = async () => new Response('down', { status: 500 });
    const { status, data } = await call({ YOUTUBE_CHANNEL_ID: 'UCabc' }, nextIp());
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.video, null);
  }

  // Upstream throws (network failure): same graceful degradation.
  {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const { data } = await call({ YOUTUBE_CHANNEL_ID: 'UCabc' }, nextIp());
    assert.equal(data.ok, true);
    assert.equal(data.video, null);
  }

  // A feed with no entries (empty channel, or malformed response): null,
  // not a thrown error from the regex extraction finding nothing.
  {
    globalThis.fetch = async () => new Response('<feed></feed>', { status: 200 });
    const { data } = await call({ YOUTUBE_CHANNEL_ID: 'UCabc' }, nextIp());
    assert.equal(data.video, null);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('# VJM youtube-latest API tests passed.');
