// Cloudflare Pages Function: GET /video/pj-intro.mp4
//
// Serves the intro video from Workers KV with real HTTP Range support.
// Cloudflare Pages' default static-asset serving ignores Range requests
// entirely (confirmed: a Range GET on /assets/* returns a full 200, never
// 206), which is why <video> stalls forever on anything but a tiny file.
// KV has no such limitation once we handle Range ourselves here.
//
// Env: vjm_video (KV binding, bound in both Preview and Production).

const CONTENT_TYPE = 'video/mp4';

export async function onRequestHead(context) {
  const { env } = context;
  if (!env.vjm_video) return new Response(null, { status: 503 });
  const buf = await env.vjm_video.get('pj-intro.mp4', { type: 'arrayBuffer' });
  if (!buf) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': String(buf.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.vjm_video) return new Response('Video storage not configured.', { status: 503 });

  const buf = await env.vjm_video.get('pj-intro.mp4', { type: 'arrayBuffer' });
  if (!buf) return new Response('Video not found.', { status: 404 });

  const total = buf.byteLength;
  const range = request.headers.get('Range');

  if (!range) {
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match || (match[1] === '' && match[2] === '')) {
    return new Response('Malformed Range header.', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }

  // A leading-empty spec ("bytes=-500") is a *suffix* range per RFC 7233
  // §2.1: the last 500 bytes, not bytes 0-500. Players fetching a trailing
  // moov atom (or scrubbing to the end) rely on this — treating it as a
  // normal range silently served the wrong bytes as a "successful" 206.
  let start, end;
  if (match[1] === '') {
    const suffixLength = parseInt(match[2], 10);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] ? parseInt(match[2], 10) : total - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    return new Response('Range not satisfiable.', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  end = Math.min(end, total - 1);

  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
