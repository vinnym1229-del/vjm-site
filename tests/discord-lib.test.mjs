// Regression coverage for functions/api/_lib/discord.js -- now the last
// functions/api/_lib/*.js file with zero test references (ai.js was closed in
// the prior run). It's imported by whop-webhook.js, market-brief.js, and
// content-sync.js, but every one of those handlers' tests only mocks
// globalThis.fetch to return a status code -- none of them ever inspect the
// request body postEmbed actually sends, so the safety rails this file's own
// header comment promises (@everyone/@here stripping, embed size limits,
// mentions disabled by default) have never been exercised even indirectly.
// Course titles, announcement text, and other content that flows into these
// embeds can contain user- or CMS-authored text, so a broken sanitizer would
// let a stray "@everyone" reach a live Discord channel undetected.
import assert from 'node:assert/strict';
import { sanitizeDiscordText, postEmbed } from '../functions/api/_lib/discord.js';

const HOOK = 'https://discord.com/api/webhooks/123/abc';

// ─── sanitizeDiscordText ────────────────────────────────────────────────────
{
  assert.equal(sanitizeDiscordText('hey @everyone check this out'), 'hey @​everyone check this out');
  assert.equal(sanitizeDiscordText('@here now'), '@​here now', 'case-sensitive literal match');
  assert.equal(sanitizeDiscordText('@EVERYONE @Here'), '@​EVERYONE @​Here', 'matching is case-insensitive');
  assert.equal(sanitizeDiscordText('nothing pingable here'), 'nothing pingable here');

  // Control characters (other than the ones markdown/whitespace need) are stripped.
  assert.equal(sanitizeDiscordText(String.fromCharCode(97, 0, 98, 7, 99)), 'abc', 'null and bell bytes removed');
  assert.equal(sanitizeDiscordText('line1\nline2\tindented'), 'line1\nline2\tindented', 'newline and tab preserved');

  assert.equal(sanitizeDiscordText(null), '', 'null coerces to empty string, not "null"');
  assert.equal(sanitizeDiscordText(undefined), '');
  assert.equal(sanitizeDiscordText(42), '42', 'non-string input is coerced, not thrown on');

  assert.equal(sanitizeDiscordText('x'.repeat(4000)).length, 3900, 'hard-truncated at 3900 chars');
}

// ─── postEmbed: webhook URL validation ──────────────────────────────────────
{
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 204 }); };
  try {
    assert.equal(await postEmbed('', { title: 't' }), false, 'empty URL rejected without a network call');
    assert.equal(await postEmbed('https://evil.example.com/webhooks/123/abc', { title: 't' }), false, 'non-Discord host rejected');
    assert.equal(await postEmbed('https://discord.com/not-a-webhook-path', { title: 't' }), false, 'discord.com but wrong path rejected');
    assert.equal(called, false, 'none of the rejected URLs above should ever reach fetch');

    assert.equal(await postEmbed('https://discordapp.com/api/webhooks/1/x', { title: 't' }), true, 'the legacy discordapp.com host is also accepted');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─── postEmbed: payload sanitization and limits ─────────────────────────────
{
  let sentBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return new Response(null, { status: 204 }); };
  try {
    const manyFields = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }));
    await postEmbed(HOOK, {
      title: 'Big news @everyone',
      description: '@here read this',
      fields: manyFields,
    });

    assert.equal(sentBody.embeds[0].title, 'Big news @​everyone', 'title is sanitized');
    assert.equal(sentBody.embeds[0].description, '@​here read this', 'description is sanitized');
    assert.equal(sentBody.embeds[0].fields.length, 25, 'fields are capped at 25');
    assert.deepEqual(
      sentBody.allowed_mentions,
      { parse: [] },
      'mentions are disabled by default even though the text is already de-fanged',
    );
    assert.equal(sentBody.username, 'VJM Brief');
    assert.ok(sentBody.embeds[0].footer.text.includes('Educational only'));

    await postEmbed(HOOK, { title: 't', description: 'd' }, true);
    assert.equal(sentBody.allowed_mentions, undefined, 'allowMentions=true drops the parse:[] restriction');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─── postEmbed: delivery outcome by response status ─────────────────────────
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await postEmbed(HOOK, { title: 't' }), true, '204 = delivered');

    globalThis.fetch = async () => new Response(null, { status: 429 });
    assert.equal(await postEmbed(HOOK, { title: 't' }), false, '429 (rate limited) is treated as a retryable failure, not success');

    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal(await postEmbed(HOOK, { title: 't' }), false, 'a thrown fetch error must degrade to false, never propagate');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('# VJM discord lib tests passed.');
