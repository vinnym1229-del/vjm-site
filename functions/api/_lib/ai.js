// Cloudflare Workers AI wrapper. Uses the `AI` binding — no external API key,
// no per-token billing on the free allocation. Fails soft: callers must
// degrade to data-only output when this returns null.

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export function aiConfigured(env) {
  return Boolean(env.AI && typeof env.AI.run === 'function');
}

export async function complete(env, { system, messages, maxTokens = 700, model = DEFAULT_MODEL }) {
  if (!aiConfigured(env)) return null;
  try {
    const result = await env.AI.run(model, {
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...(messages || []),
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    const text = result && (result.response || result.result || result.text);
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

export const MARKET_GUARDRAILS = `You are the VJM Market Assistant for an EDUCATIONAL trading site.
Hard rules you must follow:
- Education and market information ONLY. Never give personalized financial advice,
  never tell the user to buy or sell a specific security, never predict prices with certainty.
- Use only the DATA block provided. If something is not in the data, say you don't have it.
- Always mention the as-of time of the data when citing numbers.
- Be concise, direct, practical; match the brand voice but stay professional.
- End answers that discuss risk with one short line reminding it is educational, not financial advice.`;
