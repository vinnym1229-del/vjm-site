# Discord Integration Design

Status: **designed, not wired.** No Discord calls are made anywhere on this
branch. Nothing posts, roles, or syncs until the owner supplies credentials and
explicitly enables dry-run mode. This document is the implementation contract.

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
