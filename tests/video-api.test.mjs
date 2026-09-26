// Regression coverage for functions/video/pj-intro.mp4.js — the KV-backed
// Range-request handler the intro video relies on (Cloudflare Pages' default
// static-asset serving ignores Range entirely, per the file's own comment).
// Until now this had only a textual/wiring check (tests/pj-futures.test.mjs
// confirms index.html points <video> at /video/pj-intro.mp4), never a call
// into onRequestGet/onRequestHead.
//
// Building that coverage surfaced a real bug: a suffix byte-range spec
// ("bytes=-500", RFC 7233 §2.1 — "the last 500 bytes") was parsed the same
// as a leading-empty match, i.e. start=0, giving back the *first* 501 bytes
// instead of the last 500. Some MP4 players issue exactly this request to
// fetch a trailing moov atom (or to scrub to the end of the file), and would
// have silently gotten the wrong slice back as a "successful" 206 — no error,
// just corrupt playback. Fixed in the same commit as this test.
//
// Second incident, 2026-08-31 (the read-amplification tests at the bottom):
// every hit used to pull the ENTIRE object out of KV as an ArrayBuffer — the
// player's opening HEAD read the whole video just to report Content-Length,
// the GET that followed read it all over again, and each seek read it all
// again before slicing. The handler now takes the size from KV metadata and
// streams, so a HEAD transfers no body at all and a Range GET stops pulling
// once it has the bytes it was asked for. The mock KV below fails the test if
// the handler ever reaches for get(..., {type:'arrayBuffer'}) again, and
// counts bytes actually pulled through the stream.
import assert from 'node:assert/strict';
import { onRequestGet, onRequestHead } from '../functions/video/pj-intro.mp4.js';

// 1000 bytes, each byte i has value i % 256, so a slice's contents can be
// checked without needing meaningful "video" data.
const TOTAL = 1000;
const CHUNK = 100; // KV hands the body over in chunks; small enough to observe
function makeVideoBuf() {
  const arr = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) arr[i] = i % 256;
  return arr.buffer;
}

// A lazily-pulled stream that records how many bytes the handler actually
// consumed — the whole point of the read-amplification fix.
function streamOf(buf, stats) {
  const all = new Uint8Array(buf);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= all.length) { controller.close(); return; }
      const next = all.slice(offset, Math.min(all.length, offset + CHUNK));
      offset += next.length;
      stats.bytesPulled += next.length;
      controller.enqueue(next);
    },
  }, { highWaterMark: 0 }); // no read-ahead, so bytesPulled reflects the handler alone
}

// withSize=false simulates an object uploaded before the size metadata
// existed: the handler must still work, with a single full read.
function kvEnv(buf = makeVideoBuf(), { withSize = true } = {}) {
  const stats = { reads: 0, bytesPulled: 0 };
  return {
    stats,
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream', 'KV must be read as a stream, not buffered whole');
        if (key !== 'pj-intro.mp4') return { value: null, metadata: null };
        stats.reads += 1;
        return { value: streamOf(buf, stats), metadata: withSize ? { size: new Uint8Array(buf).length } : null };
      },
      async get() {
        throw new Error('regression: the whole object must not be read via get()');
      },
    },
  };
}

function req(rangeHeader) {
  const headers = rangeHeader ? { Range: rangeHeader } : {};
  return new Request('https://example.com/video/pj-intro.mp4', { headers });
}

async function bodyBytes(res) {
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

// No vjm_video binding fails closed, not a broken video tag.
{
  const res = await onRequestGet({ env: {}, request: req() });
  assert.equal(res.status, 503);
}
{
  const res = await onRequestHead({ env: {} });
  assert.equal(res.status, 503);
}

// KV has no object under the key yet (not uploaded) -> 404, not a crash.
{
  const emptyEnv = { vjm_video: { async getWithMetadata() { return { value: null, metadata: null }; } } };
  const res = await onRequestGet({ env: emptyEnv, request: req() });
  assert.equal(res.status, 404);
  const head = await onRequestHead({ env: emptyEnv });
  assert.equal(head.status, 404);
}

// No Range header at all -> full 200 with the whole buffer.
{
  const res = await onRequestGet({ env: kvEnv(), request: req() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, TOTAL);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[999], 999 % 256);
}

// HEAD reports size/Accept-Ranges without a body, so the player knows
// Range is supported before it ever requests one.
{
  const res = await onRequestHead({ env: kvEnv() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
}

// A normal "bytes=start-end" range returns exactly that slice as 206.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=100-199') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 100-199/1000');
  assert.equal(res.headers.get('Content-Length'), '100');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 100);
  assert.equal(bytes[0], 100 % 256);
  assert.equal(bytes[99], 199 % 256);
}

// An open-ended "bytes=start-" range runs to the end of the file.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=900-') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 900-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 100);
  assert.equal(bytes[0], 900 % 256);
}

// A "bytes=end-" range past the end of the file clamps rather than
// overrunning the buffer.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=990-5000') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 990-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 10);
}

// The suffix-range bug: "bytes=-500" must return the LAST 500 bytes
// (900-999), not the first 500 (the pre-fix behavior).
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=-500') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 500-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 500);
  assert.equal(bytes[0], 500 % 256, 'suffix range must start 500 bytes from the end, not from byte 0');
  assert.equal(bytes[499], 999 % 256);
}

// A suffix range longer than the whole file just clamps to the start.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=-5000') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 0-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 1000);
}

// A multi-range request ("bytes=0-99,200-299", RFC 7233 §2.1) used to match
// only the first "start-end" pair against the single-spec regex and come
// back as a 206 covering just bytes 0-99 — a request for two ranges silently
// answered with one, no error anywhere, indistinguishable from a client that
// only asked for the first range. Per RFC 7233 §3.1 a server unwilling to
// multipart-serve every requested range must not return a partial 206 for
// it, so this must fall back to the full 200 instead.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=0-99,200-299') });
  assert.equal(res.status, 200, 'a multi-range request must not come back as a 206 covering only the first range');
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
  assert.equal(res.headers.get('Content-Range'), null);
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, TOTAL, 'the full object must be served, not just the first requested sub-range');
}

// asBytes() normalizes every chunk shape a byte stream could hand back to a
// Uint8Array before slicing. Every fixture above enqueues plain Uint8Array
// chunks, so a DataView or bare ArrayBuffer chunk had never actually reached
// this code — a real gap, since `new Uint8Array(view)` (skipping the
// `.buffer`/`.byteOffset`/`.byteLength` unwrap) silently produces a
// zero-length array instead of throwing, which would have shipped as a
// missing chunk of video with no error anywhere. The range below spans both
// chunks so both the DataView (ArrayBuffer.isView) and bare-ArrayBuffer
// (neither Uint8Array nor a view) branches run in one request.
{
  const buf = makeVideoBuf();
  const bytes = new Uint8Array(buf);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new DataView(bytes.buffer, 0, 500));
      controller.enqueue(bytes.buffer.slice(500, 1000));
      controller.close();
    },
  });
  const env = {
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream');
        return { value: stream, metadata: { size: TOTAL } };
      },
    },
  };
  const res = await onRequestGet({ env, request: req('bytes=200-799') });
  assert.equal(res.status, 206);
  const out = await bodyBytes(res);
  assert.deepEqual(out, bytes.subarray(200, 800),
    'a DataView or bare-ArrayBuffer chunk must slice to the same bytes as a Uint8Array chunk');
}

// Malformed and unsatisfiable ranges both fail as 416 with a Content-Range
// hint, never a 200/206 of the wrong data.
{
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=') });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('Content-Range'), 'bytes */1000');
}
{
  const res = await onRequestGet({ env: kvEnv(), request: req('nonsense') });
  assert.equal(res.status, 416);
}
{
  // start past the end of the file.
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=5000-6000') });
  assert.equal(res.status, 416);
}
{
  // start > end.
  const res = await onRequestGet({ env: kvEnv(), request: req('bytes=200-100') });
  assert.equal(res.status, 416);
}

// ---------------------------------------------------------------------------
// Read amplification (2026-08-31 incident).

// A HEAD answers from KV metadata alone: one lookup, zero body bytes.
{
  const env = kvEnv();
  const res = await onRequestHead({ env });
  assert.equal(res.status, 200);
  assert.equal(env.stats.reads, 1, 'HEAD must read the key once');
  assert.equal(env.stats.bytesPulled, 0, 'HEAD must not pull the video body out of KV');
}

// A Range GET stops pulling once the requested bytes are in hand — the tail
// of the object is never transferred. (One chunk of read-ahead is inherent to
// a queued ReadableStream, hence the CHUNK slack.)
{
  const env = kvEnv();
  const res = await onRequestGet({ env, request: req('bytes=0-99') });
  assert.equal(res.status, 206);
  assert.equal(env.stats.reads, 1, 'one KV lookup per request');
  assert.ok(env.stats.bytesPulled <= 100 + CHUNK,
    `a 100-byte range pulled ${env.stats.bytesPulled} bytes; the rest of the object must not be read`);
}
{
  const env = kvEnv();
  await onRequestGet({ env, request: req('bytes=400-499') });
  assert.ok(env.stats.bytesPulled <= 500 + CHUNK,
    `a mid-file range pulled ${env.stats.bytesPulled} bytes; nothing past the range end should be read`);
}

// A 416 gives up without pulling the body at all.
{
  const env = kvEnv();
  const res = await onRequestGet({ env, request: req('bytes=5000-6000') });
  assert.equal(res.status, 416);
  assert.equal(env.stats.bytesPulled, 0, 'an unsatisfiable range must not read the body');
}

// Objects stored before the size metadata existed still work: one full read,
// correct size, correct slice — degraded, never broken.
{
  const env = kvEnv(makeVideoBuf(), { withSize: false });
  const res = await onRequestGet({ env, request: req('bytes=-500') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 500-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes[0], 500 % 256);
  assert.equal(env.stats.reads, 1, 'the metadata-less fallback must still read the object only once');
}
{
  const env = kvEnv(makeVideoBuf(), { withSize: false });
  const res = await onRequestHead({ env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
}
{
  const env = kvEnv(makeVideoBuf(), { withSize: false });
  const res = await onRequestGet({ env, request: req() });
  assert.equal(res.status, 200);
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, TOTAL);
}

// ---------------------------------------------------------------------------
// sizeFromMetadata() fallback chain and validation (2026-09-25 coverage pass).
// Every case above always uploads {size: N}; the `.length`/`.contentLength`
// spellings, the string-vs-number coercion, and the "reject anything that
// isn't a non-negative integer" guard the file's own comment promises had
// never actually run.

function metaEnv(metadata) {
  return {
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream');
        return { value: streamOf(makeVideoBuf(), { bytesPulled: 0 }), metadata };
      },
    },
  };
}

// `.length` and `.contentLength` are accepted alongside `.size`.
{
  const res = await onRequestHead({ env: metaEnv({ length: TOTAL }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
}
{
  const res = await onRequestHead({ env: metaEnv({ contentLength: TOTAL }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
}

// A size written as a string (some upload paths JSON-stringify metadata
// fields) is coerced, not rejected.
{
  const res = await onRequestHead({ env: metaEnv({ size: String(TOTAL) }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
}

// A non-integer or negative value is untrusted, not passed through: the
// handler must fall back to measuring the object by reading it, the same
// degraded-but-correct path used when metadata is absent entirely.
{
  const env = kvEnv(makeVideoBuf(), { withSize: false });
  env.vjm_video.getWithMetadata = async (key, opts) => {
    assert.equal(opts?.type, 'stream');
    return { value: streamOf(makeVideoBuf(), env.stats), metadata: { size: 'not-a-number' } };
  };
  const res = await onRequestHead({ env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL),
    'an invalid metadata.size must not be trusted verbatim — the handler should measure instead');
}
{
  const env = kvEnv(makeVideoBuf(), { withSize: false });
  env.vjm_video.getWithMetadata = async (key, opts) => {
    assert.equal(opts?.type, 'stream');
    return { value: streamOf(makeVideoBuf(), env.stats), metadata: { size: -5 } };
  };
  const res = await onRequestHead({ env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL),
    'a negative metadata.size must not be trusted verbatim — the handler should measure instead');
}

// ---------------------------------------------------------------------------
// cancel() swallows a throwing stream.cancel() rather than crashing the
// request. KV stream implementations are not required to make cancel()
// infallible, and a HEAD (which never wants the body) must still answer 200
// even if the underlying stream misbehaves when told to stop.
{
  const throwingStream = { cancel() { throw new Error('stream.cancel() boom'); } };
  const env = {
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream');
        return { value: throwingStream, metadata: { size: TOTAL } };
      },
    },
  };
  const res = await onRequestHead({ env });
  assert.equal(res.status, 200, 'a throwing stream.cancel() must not crash a HEAD that never reads the body');
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
}

// ---------------------------------------------------------------------------
// readSlice() against a stream that ends before delivering the requested
// bytes — e.g. KV metadata claims a size larger than what is actually
// stored. The reader hitting `done` mid-range must stop cleanly and hand
// back exactly the bytes it did get (Content-Length reflects the real,
// shorter slice — it never lies about how many bytes follow), not hang or
// throw.
{
  const shortData = makeVideoBuf().slice(0, 950); // metadata below claims TOTAL=1000
  const chunks = [];
  for (let i = 0; i < shortData.byteLength; i += CHUNK) {
    chunks.push(new Uint8Array(shortData).slice(i, Math.min(shortData.byteLength, i + CHUNK)));
  }
  const truncatedStream = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= chunks.length) return { value: undefined, done: true };
          return { value: chunks[i++], done: false };
        },
        async cancel() { /* no-op */ },
      };
    },
  };
  const env = {
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream');
        return { value: truncatedStream, metadata: { size: TOTAL } };
      },
    },
  };
  const res = await onRequestGet({ env, request: req('bytes=900-999') });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 900-999/1000');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 50, 'only the 50 bytes actually present (900-949) can be returned');
  assert.equal(res.headers.get('Content-Length'), '50',
    'Content-Length must match the real slice, never the requested-but-unavailable length');
  assert.equal(bytes[0], 900 % 256);
}

// readSlice()'s own reader.cancel() (the early-stop-once-satisfied path) can
// itself throw — the finally block must swallow that too, not let it mask
// the successful read it was trying to clean up after.
{
  const buf = makeVideoBuf();
  const all = new Uint8Array(buf);
  const cancelThrowsStream = {
    getReader() {
      let offset = 0;
      return {
        async read() {
          if (offset >= all.length) return { value: undefined, done: true };
          const next = all.slice(offset, Math.min(all.length, offset + CHUNK));
          offset += next.length;
          return { value: next, done: false };
        },
        async cancel() { throw new Error('reader.cancel() boom'); },
      };
    },
  };
  const env = {
    vjm_video: {
      async getWithMetadata(key, opts) {
        assert.equal(opts?.type, 'stream');
        return { value: cancelThrowsStream, metadata: { size: TOTAL } };
      },
    },
  };
  const res = await onRequestGet({ env, request: req('bytes=0-99') });
  assert.equal(res.status, 206, 'a throwing reader.cancel() must not stop the already-satisfied slice from returning');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, 100);
  assert.equal(bytes[0], 0);
}

console.log('VJM video Range-request tests passed.');
