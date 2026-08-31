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

console.log('VJM video Range-request tests passed.');
