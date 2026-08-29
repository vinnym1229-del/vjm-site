// Cloudflare Pages Function: /api/market-brief
//
// GET  → today's Pre-Market Brief (from cache). Responds 200 with
//        { ok:false, pending:true } until the day's brief exists — "not
//        generated yet" is a normal morning state, not an error.
// POST → regenerate now. Authorized by X-Research-Cron (scheduled job) only.
//        Optionally pushes the brief to the Discord announcements webhook.
//
// Brief contents (all labeled):
//  - futures-proxy lean (SPY/ES, QQQ/NQ composite heuristic — LOW confidence)
//  - top movers (Alpaca screener when entitled, else computed universe)
//  - headline links (Yahoo Finance RSS, real sources only)
//  - high-impact USD events count for the day (ForexFactory feed)
// Narrative via Workers AI; everything degrades to data-only if AI is down.
//
// Env: RESEARCH_DB (cache), RESEARCH_CRON_SECRET, DISCORD_ANNOUNCEMENTS_WEBHOOK,
//      BRIEF_UNIVERSE (optional comma list), standard Alpaca keys.

import { json, checkRateLimit } from './_lib/http.js';
import { timingSafeEqual } from './_lib/session.js';
import { complete, MARKET_GUARDRAILS } from './_lib/ai.js';
import { alpacaConfigured, snapshots, summarizeSnapshot, movers, computedMovers } from './_lib/alpaca.js';
import { postEmbed, sanitizeDiscordText } from './_lib/discord.js';
import { computeFuturesLean } from './_lib/integrations-core.js';

const DEFAULT_UNIVERSE = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMD', 'META', 'AMZN', 'GOOGL'];
const NEWS_SYMBOLS = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL'];
const MODULE = 'market_brief';

export async function onRequestGet(context) {
  // Abuse guard: this route costs money or calls a third party.
  const _rl = await checkRateLimit(context.env, context.request, 'brief', 30);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
  const { env } = context;
  const today = etDateString();
  const cached = await loadBrief(env, today);
  if (!cached) {
    // 200, not 404: the brief legitimately does not exist until the scheduled
    // POST runs each weekday morning, and every visitor hitting the homepage
    // before then would otherwise log a console error for a normal state.
    // Callers gate on `ok`/`pending`, not on the status code.
    return json({ ok: false, pending: true, error: 'No brief has been generated yet today.', date: today }, 200);
  }
  return json({ ok: true, ...cached }, 200);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cron = request.headers.get('X-Research-Cron') || '';
  // Constant-time, matching content-sync/research-engine for the same header.
  if (!env.RESEARCH_CRON_SECRET || !timingSafeEqual(cron, env.RESEARCH_CRON_SECRET)) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }
  try {
    const brief = await generateBrief(env);
    await storeBrief(env, brief);
    const discordResult = await maybePostToDiscord(env, brief);
    return json({ ok: true, stored: Boolean(brief._stored), discordPosted: discordResult.posted, discordDetail: discordResult.detail, brief });
  } catch (err) {
    return json({ ok: false, error: 'Brief generation failed: ' + String(err && err.message || err).slice(0, 160) }, 502);
  }
}

// ─── Generation ────────────────────────────────────────────────────────────

async function generateBrief(env) {
  const universe = parseUniverse(env.BRIEF_UNIVERSE) || DEFAULT_UNIVERSE;
  const warnings = [];
  let dataBlock = '';

  // 1) Index proxies
  let spyPct = 0;
  let qqqPct = 0;
  let proxyRows = [];
  if (alpacaConfigured(env)) {
    try {
      const snaps = await snapshots(env, ['SPY', 'QQQ']);
      const s = summarizeSnapshot('SPY', snaps.SPY);
      const q = summarizeSnapshot('QQQ', snaps.QQQ);
      spyPct = s && s.changePct !== null ? s.changePct : 0;
      qqqPct = q && q.changePct !== null ? q.changePct : 0;
      proxyRows = [s, q].filter(Boolean);
      for (const r of proxyRows) {
        dataBlock += `${r.symbol}: $${r.price}${Number.isFinite(r.changePct) ? ` (${r.changePct >= 0 ? '+' : ''}${r.changePct}% vs prior close)` : ''}\n`;
      }
    } catch { warnings.push('Index proxy quotes unavailable.'); }
  } else {
    warnings.push('Alpaca not configured — lean and movers omitted.');
  }

  // 2) Movers
  let mv = null;
  if (alpacaConfigured(env)) {
    mv = (await movers(env).catch(() => null)) || (await computedMovers(env, universe).catch(() => null));
    if (mv) {
      const fmt = (arr) => arr.filter((m) => Number.isFinite(m.changePct)).map((m) => `${m.symbol} ${m.changePct >= 0 ? '+' : ''}${m.changePct}%`).join(', ');
      dataBlock += `Gainers: ${fmt(mv.gainers)}\nLosers: ${fmt(mv.losers)}\n`;
    }
  }

  // 3) Headlines (real sources, deduped)
  const headlines = await fetchHeadlines(NEWS_SYMBOLS);
  if (headlines.length) {
    headlines.slice(0, 10).forEach((h, i) => {
      dataBlock += `News${i + 1}: ${h.title} (${h.symbol}, ${h.publisher})\n`;
    });
  } else {
    warnings.push('Headline feeds unreachable this run.');
  }

  // 4) Calendar context (count of today's USD high-impact events)
  const calendarCount = await todaysHighImpactCount();
  dataBlock += `USD high-impact events scheduled today: ${calendarCount === null ? 'unknown' : calendarCount}\n`;

  const lean = computeFuturesLean({ spyChangePct: spyPct, qqqChangePct: qqqPct });

  // 5) Narrative
  const narrative = await complete(env, {
    system: MARKET_GUARDRAILS,
    messages: [{
      role: 'user',
      content: `Write the morning PRE-MARKET BRIEF for the website community using ONLY this data:\n\n${dataBlock}\n` +
        `Futures-proxy lean computed as: ${lean.lean} (${lean.method}).\n\n` +
        `Structure it exactly as:\n` +
        `1) "Index posture:" one sentence on SPY/QQQ posture vs prior close.\n` +
        `2) "Futures lean:" one sentence stating the ${lean.lean} heuristic result and that it is a low-confidence ETF-proxy read.\n` +
        `3) "Movers:" one compact line on the notable gainers/losers.\n` +
        `4) "News worth knowing:" up to three short bullets referencing the headlines above.\n` +
        `5) "Watch level:" one practical educational pointer (e.g., respect prior close / gap fill behavior) WITHOUT telling anyone to trade.\n` +
        `Keep it under 180 words total.`,
    }],
    maxTokens: 500,
  });

  const brief = {
    module: MODULE,
    date: etDateString(),
    generatedAt: new Date().toISOString(),
    lean,
    proxies: proxyRows,
    movers: mv,
    headlines: headlines.slice(0, 8),
    calendarEventCountToday: calendarCount,
    narrative,
    narrativeEngine: narrative ? 'cloudflare-workers-ai' : null,
    dataOnly: !narrative,
    warnings,
    disclaimer: 'Educational information only — not financial advice. ETF proxies are not CME futures data.',
    _dataBlock: dataBlock,
  };
  return brief;
}

// ─── Headlines via public Yahoo RSS (same sanitizer as yahoo-news fn) ──────

async function fetchHeadlines(symbols) {
  const seen = new Set();
  const out = [];
  await Promise.all(symbols.map(async (sym) => {
    try {
      // Yahoo retired the RSS headline feed (404 direct, 429 via CF egress);
      // same JSON search endpoint yahoo-news.js migrated to.
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=8&quotesCount=0&enableFuzzyQuery=false`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PJTradesBot/1.0)', Accept: 'application/json' },
          signal: AbortSignal.timeout(6000), cf: { cacheTtl: 300, cacheEverything: true } }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const item of (Array.isArray(data && data.news) ? data.news : [])) {
        if (out.length >= 24) break;
        const title = String(item.title || '');
        const link = String(item.link || '');
        const pub = Number.isFinite(Number(item.providerPublishTime))
          ? new Date(Number(item.providerPublishTime) * 1000).toUTCString() : '';
        if (!title || !link || !/^https:/i.test(link) || seen.has(link)) continue;
        seen.add(link);
        out.push({
          symbol: sym,
          title: title.replace(/[\u0000-\u001F]/g, '').slice(0, 160),
          link,
          publisher: 'Yahoo Finance',
          publishedAt: pub ? new Date(pub).toISOString() : null,
        });
      }
    } catch { /* individual feed failure tolerated */ }
  }));
  return out;
}

function pick(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function todaysHighImpactCount() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const today = etDateString();
    let count = 0;
    for (const e of rows) {
      if (!e || e.country !== 'USD' || !e.date) continue;
      if (String(e.impact || '').toLowerCase().includes('high')) {
        try {
          if (etDateString(new Date(e.date)) === today) count++;
        } catch { /* skip malformed dates */ }
      }
    }
    return count;
  } catch {
    return null;
  }
}

function etDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// ─── Persistence (D1 preferred; per-isolate fallback documented) ───────────

let memoryBrief = null;

async function storeBrief(env, brief) {
  if (env.RESEARCH_DB) {
    try {
      await env.RESEARCH_DB.prepare(
        `INSERT INTO research_latest (cache_key, module, as_of, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(cache_key) DO UPDATE SET payload=?4, as_of=?3, updated_at=datetime('now')`
      ).bind(`${MODULE}:${brief.date}`, MODULE, brief.generatedAt, JSON.stringify(brief)).run();
      brief._stored = true;
      return;
    } catch { /* fall through */ }
  }
  memoryBrief = brief;
  brief._stored = false;
}

async function loadBrief(env, date) {
  if (env.RESEARCH_DB) {
    try {
      const row = await env.RESEARCH_DB.prepare(
        'SELECT payload FROM research_latest WHERE cache_key = ?1'
      ).bind(`${MODULE}:${date}`).first();
      if (row && row.payload) return JSON.parse(row.payload);
    } catch { /* fall through */ }
  }
  if (memoryBrief && memoryBrief.date === date) return memoryBrief;
  return null;
}

// ─── Discord push ──────────────────────────────────────────────────────────

async function maybePostToDiscord(env, brief) {
  const hook = env.DISCORD_ANNOUNCEMENTS_WEBHOOK;
  if (!hook) return { posted: false, detail: 'DISCORD_ANNOUNCEMENTS_WEBHOOK not configured (dry-run: nothing sent)' };

  const lines = [];
  lines.push(`**Pre-Market Brief — ${brief.date} (ET)**`);
  if (brief.narrative) lines.push(sanitizeDiscordText(brief.narrative));
  else {
    if (brief.lean) lines.push(`Futures-proxy lean: **${brief.lean.lean}** (low confidence, ETF proxy heuristic)`);
    if (brief.movers) {
      const fmt = (arr) => arr.map((m) => `\`${m.symbol}\``).join(' ');
      lines.push(`Gainers: ${fmt(brief.movers.gainers)}\nLosers: ${fmt(brief.movers.losers)}`);
    }
  }
  if (brief.headlines && brief.headlines.length) {
    lines.push('\n**Links:**');
    brief.headlines.slice(0, 5).forEach((h) => lines.push(`• <${h.link}>`));
  }
  lines.push('\n*Educational only — not financial advice.*');

  const okPost = await postEmbed(hook, {
    title: `VJM Pre-Market Brief — ${brief.date}`,
    description: lines.join('\n').slice(0, 3900),
    fields: [
      { name: 'Futures lean (proxy)', value: `${brief.lean ? brief.lean.lean : 'n/a'} · confidence: low`, inline: true },
      { name: 'Generated (UTC)', value: brief.generatedAt, inline: true },
    ],
  });
  return { posted: okPost, detail: okPost ? 'delivered' : 'webhook rejected or timed out' };
}

function parseUniverse(raw) {
  if (!raw) return null;
  const list = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.^-]{1,10}$/.test(s));
  return list.length >= 2 ? list.slice(0, 30) : null;
}
