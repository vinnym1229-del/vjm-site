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
import assert from 'node:assert/strict';
import { onRequestGet, onRequestHead } from '../functions/video/pj-intro.mp4.js';

function bufOf(bytes) {
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i) % 256;
  return arr.buffer;
}

// 1000 bytes, each byte i has value i % 256, so a slice's contents can be
// checked without needing meaningful "video" data.
const TOTAL = 1000;
function makeVideoBuf() {
  const arr = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) arr[i] = i % 256;
  return arr.buffer;
}

function kvEnv(buf = makeVideoBuf()) {
  return {
    vjm_video: {
      async get(key, opts) {
        if (key !== 'pj-intro.mp4') return null;
        assert.equal(opts?.type, 'arrayBuffer');
        return buf;
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
  const emptyEnv = { vjm_video: { async get() { return null; } } };
  const res = await onRequestGet({ env: emptyEnv, request: req() });
  assert.equal(res.status, 404);
}

// No Range header at all -> full 200 with the whole buffer.
{
  const res = await onRequestGet({ env: kvEnv(), request: req() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Length'), String(TOTAL));
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  const bytes = await bodyBytes(res);
  assert.equal(bytes.length, TOTAL);
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

console.log('VJM video Range-request tests passed.');
