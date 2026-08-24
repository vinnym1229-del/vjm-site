// Discord webhook sender with safety rails.
// - strips @everyone/@here pings
// - enforces embed limits
// - never logs the webhook URL

export function sanitizeDiscordText(s) {
  return String(s == null ? '' : s)
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, 3900);
}

export async function postEmbed(webhookUrl, embed, allowMentions = false) {
  if (!webhookUrl || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(webhookUrl)) {
    return false;
  }
  const payload = {
    username: 'VJM Brief',
    embeds: [{
      color: 0xdc2626,
      timestamp: new Date().toISOString(),
      footer: { text: 'Educational only — not financial advice' },
      ...embed,
      title: sanitizeDiscordText(embed.title).slice(0, 256),
      description: sanitizeDiscordText(embed.description).slice(0, 3900),
      fields: (embed.fields || []).slice(0, 25).map((f) => ({
        name: sanitizeDiscordText(f.name).slice(0, 256),
        value: sanitizeDiscordText(f.value).slice(0, 1024),
        inline: Boolean(f.inline),
      })),
    }],
    allowed_mentions: allowMentions ? undefined : { parse: [] },
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 204 = delivered; 429 = rate limited (treat as retryable failure)
    return res.status === 204;
  } catch {
    return false;
  }
}
