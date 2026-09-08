// Cloudflare Pages Function: GET /api/youtube-latest
//
// The most recent video from the owner's YouTube channel, for an
// auto-updating "latest video" card on the homepage About section — no
// API key, no login from the owner required. YouTube publishes a public
// RSS feed per channel (the same no-key-needed category as live-stats.js's
// Discord invite lookup): https://www.youtube.com/feeds/videos.xml?channel_id=…
//
// YOUTUBE_CHANNEL_ID must be the channel's UC… id, not the @handle — the
// feed URL does not accept handles. Find it in YouTube Studio under
// Settings > Channel > Advanced ("Channel ID"), or on the channel page
// itself (view source, search for "channelId"). Unset or wrong: this
// degrades to { ok: true, video: null } and the card on the page just
// doesn't render — it never breaks the page or shows someone else's video.
import { json, checkRateLimit } from './_lib/http.js';

export async function onRequestGet(context) {
  const _rl = await checkRateLimit(context.env, context.request, 'youtube-latest', 60);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);

  const video = await latestVideo(context.env);
  return json({ ok: true, video }, 200, { 'Cache-Control': 'public, max-age=900' });
}

async function latestVideo(env) {
  const channelId = env.YOUTUBE_CHANNEL_ID;
  if (!channelId) return null;
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 900, cacheEverything: true } }
    );
    if (!res.ok) return null;
    const xml = await res.text();
    // First <entry> is always the most recent upload — the feed is already
    // newest-first, so no sorting needed. A minimal regex extraction rather
    // than a full XML parser: the feed's shape is fixed and small enough
    // that dragging in a parser (not available by default in this runtime
    // anyway) buys nothing.
    const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml);
    if (!entry) return null;
    const body = entry[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(body)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(body)?.[1];
    const published = /<published>([^<]+)<\/published>/.exec(body)?.[1];
    if (!videoId || !title) return null;
    return {
      id: videoId,
      title: decodeXmlEntities(title),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      publishedAt: published || null,
    };
  } catch {
    return null;
  }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
