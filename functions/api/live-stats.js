// Cloudflare Pages Function: GET /api/live-stats
//
// Real, auto-updating headline numbers instead of hand-typed ones.
//   - Discord member count: Discord's public invite endpoint. No API key,
//     no config — works out of the box for any public server invite.
//   - Whop rating/review count/member count: Whop's REST API. Needs
//     WHOP_API_KEY (Account API key, "access_pass:basic:read" scope,
//     free — created once in the Whop dashboard) + WHOP_PRODUCT_ID.
//     Omit either and this half just falls back to the site's static
//     numbers — never breaks the page.
//
// Cached at the edge for 5 minutes; this endpoint is meant to be polled
// by every page load, so keep it cheap.

import { json, checkRateLimit } from './_lib/http.js';

const DISCORD_INVITE_CODE = 'pjtrades';

export async function onRequestGet(context) {
  // Abuse guard: public read that calls third parties
  const _rl = await checkRateLimit(context.env, context.request, 'live-stats', 60);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
  const { env } = context;
  const [discord, whop] = await Promise.all([discordStats(), whopStats(env)]);
  return json({ ok: true, discord, whop, asOf: new Date().toISOString() }, 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

async function discordStats() {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/invites/${DISCORD_INVITE_CODE}?with_counts=true`,
      { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      memberCount: data.approximate_member_count ?? null,
      onlineCount: data.approximate_presence_count ?? null,
    };
  } catch {
    return null;
  }
}

async function whopStats(env) {
  if (!env.WHOP_API_KEY || !env.WHOP_PRODUCT_ID) return null;
  try {
    const res = await fetch(`https://api.whop.com/api/v2/products/${env.WHOP_PRODUCT_ID}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
      signal: AbortSignal.timeout(6000),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      memberCount: data.member_count ?? null,
      reviewCount: data.published_reviews_count ?? null,
    };
  } catch {
    return null;
  }
}
