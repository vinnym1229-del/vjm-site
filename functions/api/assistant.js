// Cloudflare Pages Function: POST /api/assistant
//
// Market Q&A chatbot. Grounded on LIVE server-side data (Alpaca snapshots,
// movers when entitled, today's calendar count). AI narrative comes from
// Cloudflare Workers AI via the `AI` binding — free allocation, no API key.
// With no AI binding the endpoint still answers with pure data context.
//
// Modes:
//  default        → grounded on live market data block
//  lesson         → body { question, lessonText } — answers restricted to the
//                   supplied lesson text (course companion mode)

import { json, checkRateLimit } from './_lib/http.js';
import { complete, MARKET_GUARDRAILS, aiConfigured } from './_lib/ai.js';
import { alpacaConfigured, snapshots, summarizeSnapshot, movers, computedMovers } from './_lib/alpaca.js';

const UNIVERSE = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMD', 'META'];

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    return await handle(context);
  } catch {
    return json({ ok: false, error: 'Assistant is temporarily unavailable.' }, 502);
  }
}

async function handle({ request, env }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only.' }, 405);

  const limit = await checkRateLimit(env, request, 'assistant', 8);
  if (!limit.allowed) {
    return json({ ok: false, error: 'Too many questions in a row — give it a minute.' }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid request.' }, 400); }

  const question = String(body.question || '').trim().slice(0, 500);
  const lessonText = String(body.lessonText || '').slice(0, 6000);
  if (!question) return json({ ok: false, error: 'Ask a question first.' }, 400);

  // Lesson-companion mode needs no market data at all.
  if (lessonText && question) {
    return answerFromLesson(env, question, lessonText);
  }

  // ── Build the live DATA block ──────────────────────────────────────────
  let dataBlock = '';
  const asOfParts = [];
  let aiReady = true;

  if (!alpacaConfigured(env)) {
    aiReady = false;
    dataBlock += 'Market data: not configured on the server.\n';
  } else {
    try {
      const snaps = await snapshots(env, UNIVERSE);
      const rows = UNIVERSE.map((s) => summarizeSnapshot(s, snaps[s])).filter(Boolean);
      for (const r of rows.slice(0, 4)) {
        dataBlock += `${r.symbol}: $${r.price} (${r.changePct >= 0 ? '+' : ''}${r.changePct}% vs prior close, IEX feed${r.asOf ? ', asOf ' + r.asOf : ''})\n`;
        if (r.asOf) asOfParts.push(r.asOf);
      }
      const mv = (await movers(env)) || (await computedMovers(env, UNIVERSE));
      if (mv) {
        const fmt = (arr) => arr.map((m) => `${m.symbol} ${m.changePct !== null ? (m.changePct >= 0 ? '+' : '') + m.changePct + '%' : ''}`).join(', ');
        dataBlock += `Top movers — gainers: ${fmt(mv.gainers)} | losers: ${fmt(mv.losers)} (source: ${mv.source})\n`;
      }
    } catch {
      aiReady = false;
      dataBlock += 'Market data: temporarily unreachable right now.\n';
    }
  }

  // Never let the model narrate numbers it does not have. Without this the
  // answer comes back as "SPY is up/down by X%" -- a fill-in-the-blank
  // template presented to the user as grounded analysis.
  if (!aiReady) {
    return json({
      ok: true,
      mode: 'data-unavailable',
      narrative: null,
      message: 'Live market data is unavailable right now, so I cannot give you prices I can stand behind. Try again in a few minutes.',
      disclaimer: 'Educational information only — not financial advice.',
    });
  }

  const system = MARKET_GUARDRAILS;
  const userPrompt = `DATA BLOCK:\n${dataBlock || '(no live data available)'}\n\nUser question: ${question}`;

  const answer = await complete(env, {
    system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 650,
  });

  if (!answer) {
    // Honest degradation: return the raw grounded data so the UI can show it.
    return json({
      ok: true,
      mode: 'data-only',
      narrative: null,
      dataBlock,
      message: aiConfigured(env)
        ? 'The narrative engine did not respond; here is the live data behind your question.'
        : 'Narrative engine not enabled on this deployment (Workers AI binding missing); showing live data only.',
      disclaimer: 'Educational information only — not financial advice.',
    });
  }

  return json({
    ok: true,
    mode: 'grounded',
    narrative: answer,
    dataContext: dataBlock,
    asOf: asOfParts[0] || new Date().toISOString(),
    engine: 'cloudflare-workers-ai',
    disclaimer: 'AI-generated summary of live data. Educational only — not financial advice. Verify prices on your platform before acting.',
  });
}

function answerFromLesson(env, question, lessonText) {
  // Deterministic guardrails without needing the model: we only ever pass the
  // lesson text as the single source of truth.
  const system = `You are a course companion for a trading-education lesson.
Answer ONLY using the LESSON TEXT provided. If the answer is not contained in it,
reply exactly that the lesson does not cover this and suggest reviewing the module or asking Vinny in Discord.
Never add outside market opinions or advice. Keep answers under 180 words.`;
  return complete(env, {
    system,
    messages: [{ role: 'user', content: `LESSON TEXT:\n"""\n${lessonText}\n"""\n\nQuestion: ${question}` }],
    maxTokens: 400,
  }).then((answer) => {
    if (!answer) {
      return json({ ok: false, error: 'Lesson assistant is not enabled on this deployment.' }, 503);
    }
    return json({
      ok: true,
      mode: 'lesson',
      narrative: answer,
      engine: 'cloudflare-workers-ai',
      disclaimer: 'Generated strictly from this lesson\'s text. If anything seems off, trust the lesson and ask in Discord.',
    });
  });
}
