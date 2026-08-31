// Regression coverage for functions/api/_lib/ai.js -- the last
// functions/api/_lib/*.js file with zero test references (discord.js is the
// other; both were called out in prior runs' logs as remaining). It's
// imported by three handlers with their own test suites -- assistant.js,
// market-brief.js, premium-market-analyst.js -- but none of those tests ever
// set env.AI, so every one of them only ever exercises aiConfigured()
// returning false and short-circuiting to null. complete()'s actual request
// shape, its result.response/result.result/result.text fallback chain (the
// same kind of defensive unwrap that was once wrong for Alpaca's snapshot
// shape), and its fail-soft catch have never run at all, even indirectly.
import assert from 'node:assert/strict';
import { aiConfigured, complete, MARKET_GUARDRAILS } from '../functions/api/_lib/ai.js';

// ─── aiConfigured ───────────────────────────────────────────────────────────
{
  assert.equal(aiConfigured({}), false, 'no AI binding at all');
  assert.equal(aiConfigured({ AI: {} }), false, 'AI binding present but .run is not a function');
  assert.equal(aiConfigured({ AI: { run: 'not-a-function' } }), false);
  assert.equal(aiConfigured({ AI: { run: async () => {} } }), true);
}

// ─── complete(): short-circuits when unconfigured ──────────────────────────
{
  const result = await complete({}, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result, null, 'no AI binding -> null without attempting a call');
}

// ─── complete(): request shape ──────────────────────────────────────────────
{
  let seenModel, seenBody;
  const env = {
    AI: {
      run: async (model, body) => {
        seenModel = model;
        seenBody = body;
        return { response: 'ok' };
      },
    },
  };

  await complete(env, { system: 'be terse', messages: [{ role: 'user', content: 'q1' }] });
  assert.equal(seenModel, '@cf/meta/llama-3.1-8b-instruct-fp8', 'default model when none is given');
  assert.deepEqual(seenBody.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'q1' },
  ], 'system message must be prepended when given');
  assert.equal(seenBody.max_tokens, 700, 'default max_tokens');
  assert.equal(seenBody.temperature, 0.3);

  await complete(env, { messages: [{ role: 'user', content: 'q2' }], maxTokens: 50, model: 'custom-model' });
  assert.deepEqual(seenBody.messages, [{ role: 'user', content: 'q2' }], 'no system key at all when system is omitted');
  assert.equal(seenBody.max_tokens, 50, 'maxTokens is passed through');
  assert.equal(seenModel, 'custom-model', 'model override is passed through');

  await complete(env, { messages: undefined });
  assert.deepEqual(seenBody.messages, [], 'a missing messages array must not throw, just send none');
}

// ─── complete(): result-shape fallback chain ────────────────────────────────
{
  const runReturning = (result) => ({ AI: { run: async () => result } });

  assert.equal(await complete(runReturning({ response: 'from response' }), { messages: [] }), 'from response');
  assert.equal(
    await complete(runReturning({ result: 'from result' }), { messages: [] }),
    'from result',
    'result.response absent -> falls back to result.result',
  );
  assert.equal(
    await complete(runReturning({ text: 'from text' }), { messages: [] }),
    'from text',
    'both result.response and result.result absent -> falls back to result.text',
  );
  assert.equal(
    await complete(runReturning({ response: 'first wins', result: 'second', text: 'third' }), { messages: [] }),
    'first wins',
    'response takes priority over result/text when more than one is present',
  );

  // Whitespace-only or entirely missing text collapses to null, not "" or undefined.
  assert.equal(await complete(runReturning({ response: '   ' }), { messages: [] }), null, 'whitespace-only text is not a real answer');
  assert.equal(await complete(runReturning({}), { messages: [] }), null, 'none of response/result/text present');
  assert.equal(await complete(runReturning(null), { messages: [] }), null, 'AI.run resolving to null must not throw');
  assert.equal(await complete(runReturning({ response: 42 }), { messages: [] }), null, 'a non-string response must not be coerced into an answer');

  // Real text is trimmed.
  assert.equal(await complete(runReturning({ response: '  padded  ' }), { messages: [] }), 'padded');
}

// ─── complete(): fails soft when the AI binding throws ─────────────────────
{
  const env = { AI: { run: async () => { throw new Error('Workers AI is down'); } } };
  const result = await complete(env, { messages: [{ role: 'user', content: 'q' }] });
  assert.equal(result, null, 'a thrown error from the AI binding must degrade to null, never propagate');
}

// ─── MARKET_GUARDRAILS ───────────────────────────────────────────────────────
{
  // The system prompt every AI-backed handler relies on to keep the assistant
  // inside its documented product boundaries -- a scope drift here would
  // silently loosen every caller at once.
  assert.match(MARKET_GUARDRAILS, /Never give personalized financial advice/);
  assert.match(MARKET_GUARDRAILS, /educational, not financial advice/);
  assert.match(MARKET_GUARDRAILS, /whop\.com\/pjtradespremium/);
}

console.log('# VJM ai lib tests passed.');
