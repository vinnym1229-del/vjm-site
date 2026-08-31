// Cloudflare Pages Function: GET /video/pj-intro.mp4
//
// Serves the intro video from Workers KV with real HTTP Range support.
// Cloudflare Pages' default static-asset serving ignores Range requests
// entirely (confirmed: a Range GET on /assets/* returns a full 200, never
// 206), which is why <video> stalls forever on anything but a tiny file.
// KV has no such limitation once we handle Range ourselves here.
//
// Reading only what is needed (2026-08-31): this used to pull the ENTIRE
// object out of KV as an ArrayBuffer on every hit — the player's opening HEAD
// read all 25MB just to report Content-Length, the following GET read it all
// again, and every seek read it all again before slicing. Now:
//   * HEAD reads metadata only and never touches the body,
//   * a full GET streams the object straight through instead of buffering it,
//   * a Range GET streams and stops pulling the moment the requested bytes
//     are in hand, so the tail of the file is never transferred.
// KV's binding has no server-side range read (get() takes only cacheTtl/type,
// see /kv/api/read-key-value-pairs), so the object size is carried in the
// key's KV metadata, written at upload time as {"size": <bytes>}. Without
// that metadata we fall back to one full read — still one, never two.
//
// Range semantics are unchanged, including the RFC 7233 §2.1 suffix form.
//
// Env: vjm_video (KV binding, bound in both Preview and Production).

const CONTENT_TYPE = 'video/mp4';
const KEY = 'pj-intro.mp4';
const CACHE_CONTROL = 'public, max-age=86400';

// Object size from KV metadata, so neither a HEAD nor the "/total" in a
// Content-Range costs a body read. Metadata is caller-written, so accept the
// plausible spellings and trust nothing that is not a non-negative integer.
function sizeFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = metadata.size ?? metadata.length ?? metadata.contentLength;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function cancel(stream) {
  try { if (stream && typeof stream.cancel === 'function') stream.cancel(); } catch { /* already closed */ }
}

function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

async function streamToBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const bytes = asBytes(value);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Copies out bytes [start, end] and cancels the reader as soon as the range
// is satisfied — the rest of the object is never pulled from KV.
async function readSlice(stream, start, end) {
  const wanted = end - start + 1;
  const out = new Uint8Array(wanted);
  const reader = stream.getReader();
  let seen = 0;    // bytes consumed from the stream so far
  let written = 0; // bytes copied into out
  try {
    while (written < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = asBytes(value);
      const chunkStart = seen;
      seen += chunk.length;
      if (seen <= start) continue; // entirely before the requested range
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(chunk.length, end - chunkStart + 1);
      out.set(chunk.subarray(from, to), written);
      written += to - from;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return written === wanted ? out : out.subarray(0, written);
}

// One KV read per request. Returns { size, body } where body is the stream
// still holding the object (or null when the size came from metadata and the
// caller does not need bytes), or null when the key is absent.
async function loadObject(kv, { needBody }) {
  const { value, metadata } = await kv.getWithMetadata(KEY, { type: 'stream' });
  if (!value) return null;

  const size = sizeFromMetadata(metadata);
  if (size != null) {
    if (!needBody) { cancel(value); return { size, body: null }; }
    return { size, body: value };
  }

  // No size in metadata: measure it the only way KV allows, by reading the
  // object once. Return the bytes so the caller does not read a second time.
  const bytes = await streamToBytes(value);
  return { size: bytes.length, body: null, bytes };
}

export async function onRequestHead(context) {
  const { env } = context;
  if (!env.vjm_video) return new Response(null, { status: 503 });

  const obj = await loadObject(env.vjm_video, { needBody: false });
  if (!obj) return new Response(null, { status: 404 });

  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': String(obj.size),
      'Accept-Ranges': 'bytes',
    },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.vjm_video) return new Response('Video storage not configured.', { status: 503 });

  const range = request.headers.get('Range');
  const obj = await loadObject(env.vjm_video, { needBody: true });
  if (!obj) return new Response('Video not found.', { status: 404 });

  const total = obj.size;

  if (!range) {
    // Stream straight through rather than buffering the whole object first.
    const body = obj.body || obj.bytes;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match || (match[1] === '' && match[2] === '')) {
    cancel(obj.body);
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
    cancel(obj.body);
    return new Response('Range not satisfiable.', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  end = Math.min(end, total - 1);

  const slice = obj.body
    ? await readSlice(obj.body, start, end)
    : obj.bytes.subarray(start, end + 1);

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Content-Length': String(slice.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
