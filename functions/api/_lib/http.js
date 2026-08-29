// Shared HTTP + rate-limit utilities for VJM Pages Functions.

import { buildSessionCookie, buildClearCookie } from './session.js';

export const NO_STORE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

export function jsonWithSession(obj, token, maxAgeSeconds, status = 200) {
  return json(obj, status, {
    'Set-Cookie': buildSessionCookie(token, maxAgeSeconds),
  });
}

export function jsonClearedSession(obj, status = 200) {
  return json(obj, status, { 'Set-Cookie': buildClearCookie() });
}

export function clientIp(request) {
  const fwd = request.headers.get('CF-Connecting-IP');
  if (fwd) return String(fwd).slice(0, 64);
  return 'unknown';
}

function bucketKey(request, scope, identifier) {
  // Minute-resolution window bucket.
  const minute = Math.floor(Date.now() / 60000);
  const idPart = identifier ? ':' + String(identifier).slice(0, 120) : '';
  return `${scope}:${minute}:${clientIp(request)}${idPart}`;
}

// Best-effort rate limiter. Uses an in-isolate Map (per Cloudflare isolate);
// when a D1 binding named RATELIMIT_DB is present it persists counts so the
// limit holds across isolates. Limits are per-minute by design.
const memoryBuckets = new Map();

function pruneMemory() {
  const currentMinute = Math.floor(Date.now() / 60000);
  for (const [key, entry] of memoryBuckets) {
    if (entry.minute < currentMinute - 2) memoryBuckets.delete(key);
  }
}

export async function checkRateLimit(env, request, scope, limit, identifier = '') {
  const key = bucketKey(request, scope, identifier);
  const minute = Math.floor(Date.now() / 60000);

  if (env && env.RATELIMIT_DB) {
    try {
      await env.RATELIMIT_DB
        .prepare('INSERT INTO rate_limits (bucket, window_minute, count) VALUES (?1, ?2, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1')
        .bind(key, minute)
        .run();
      const row = await env.RATELIMIT_DB
        .prepare('SELECT count FROM rate_limits WHERE bucket = ?1')
        .bind(key)
        .first();
      const count = row ? Number(row.count) : 1;
      // The minute is baked into the bucket key, so every scope+IP+minute is a
      // fresh row and nothing ever deleted them — the table grew forever. On
      // the first hit of each new bucket (count===1, so ~one delete per
      // client-minute), sweep rows older than two minutes.
      if (count === 1) {
        await env.RATELIMIT_DB
          .prepare('DELETE FROM rate_limits WHERE window_minute < ?1')
          .bind(minute - 2)
          .run().catch(() => {});
      }
      return { allowed: count <= limit, count };
    } catch {
      // D1 unavailable/misconfigured: fall through to memory limiter rather
      // than failing open OR breaking the endpoint entirely.
    }
  }

  pruneMemory();
  const existing = memoryBuckets.get(key) || { minute, count: 0 };
  if (existing.minute !== minute) {
    existing.minute = minute;
    existing.count = 0;
  }
  existing.count += 1;
  memoryBuckets.set(key, existing);
  return { allowed: existing.count <= limit, count: existing.count };
}

// Strict symbol validation shared by quote/news endpoints.
export function cleanSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/^([A-Z]+):/, '');
  if (!/^[A-Z0-9.^-]{1,10}$/.test(s)) return null;
  return s;
}

export async function fetchJsonWithTimeout(url, ms, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, cf: { cacheTtl: 0 } });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}
