# Discord Integration Design

Status: **webhook posting is live; the bot is not.** `functions/api/_lib/discord.js`'s
`postEmbed()` (sanitizes mentions, enforces embed limits, times out, never
logs the URL) is already called from three places, each gated by its own env
var -- it posts the instant the owner sets that var, with no separate "enable"
step required:
- `functions/api/whop-webhook.js` -- delivers a purchaser's access code via
  `DISCORD_WHOP_CODES_WEBHOOK`.
- `functions/api/market-brief.js` -- posts the daily brief via
  `DISCORD_ANNOUNCEMENTS_WEBHOOK` on every cron regeneration.
- `functions/api/content-sync.js` -- forwards new sheet announcements to the
  same webhook, the only one of the three with an explicit dry-run toggle
  (`CONTENT_DISCORD_DRYRUN`, defaults to true).

Everything below this line -- OAuth account linking, premium role sync, and
slash commands -- is still just a design: no `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID`, or `DISCORD_PREMIUM_ROLE_ID` reference exists anywhere in
`functions/`. This document is the implementation contract for that
remaining work.

## Principles

- The bot token lives ONLY in Cloudflare secrets. Never in repo/browser/logs.
- Stable IDs only: Discord snowflake user ID is the join key; usernames are display-only.
- Role changes go through a queue with retries/backoff and rate-limit respect.
- A reconciliation job COMPARES entitlements vs roles and reports drift to an
  admin channel; it never silently mutates roles on first mismatch.
- All automated posts carry an as-of timestamp, source labels, and the
  educational/not-financial-advice footer. Mentions sanitized; @everyone disabled.

## Account linking (OAuth2)

1. Member clicks "Connect Discord" → authorize URL with `state` (CSRF) +
   PKCE, scopes `identify` (+ `guilds.members.read` where needed).
2. Callback validates state, exchanges code server-side, stores snowflake,
   display name, avatar hash, linked_at on the member record.
3. Exact redirect URI allowlist from env; no wildcard hosts.

## Premium role sync

- Env: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_PREMIUM_ROLE_ID`.
- Entitlement source of truth = membership bridge status (Active/Renewed).
- State machine: granted → active ⇄ lapsed; removal only after N consecutive
  reconciliations agree AND grace period passes.
- Queue table `webhook_events`/`sync_jobs` (D1) with dedupe on event IDs.

## Whop (if used for entitlements)

- Webhook endpoint verifies Whop signature over the RAW body, stores event IDs
  idempotently, maps purchase/renewal/cancel/refund/expiry explicitly through
  the same state machine. Product/plan IDs live in admin settings, not HTML.
- "…#1-rated community on Whop" marketing claim requires a managed proof URL +
  owner approval before it ships anywhere.

## Slash commands (post-auth phase)

`/vjm-status` (ephemeral), `/vjm-levels QQQ|SPY` (cached+timestamped summary),
`/vjm-calendar`, `/vjm-lesson` (resume link), `/vjm-research <run-id>`.
Interactions verified via Ed25519 signature + timestamp on raw body; stale or
replayed requests rejected; long work deferred. Admin commands restricted to
configured user/role IDs server-side.
