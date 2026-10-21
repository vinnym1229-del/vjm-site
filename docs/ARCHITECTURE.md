# Architecture

## Current shape (kept deliberately)

Static HTML/CSS/JS on **Cloudflare Pages** + Pages Functions under
`functions/api/**` (file-routed). D1 optional via bindings. GitHub Actions cron
refreshes research snapshots. Apps Script bridges owner's Google Sheet to a
server-to-server lookup API.

Decision: **no framework migration in this pass.** Evidence: the monolith
problem is concentrated in one file (index.html, by far the largest of the 16
static pages at ~220 KB); auth/data integrity were the burning risks, not
tooling. A Vite/Astro split is designed (below)
but gated on the homepage rebuild phase so it lands with new structure instead
of churning working pages twice.

## Module map

```
functions/api/
  _lib/session.js       HMAC session tokens, cookie builders, secret resolution
  _lib/http.js          JSON envelope, rate limiter, symbol validation, fetch helper
  _lib/entitlements.js  tier/session-version model — what a paying member can see
  _lib/integrations-core.js pure Sheet-row/Whop/Discord-safe-content helpers (no network)
  _lib/alpaca.js        shared Alpaca accessors (assistant, market-brief)
  _lib/ai.js            Workers AI wrapper, fails soft to data-only output
  _lib/backtest-core.js deterministic event-study engine (pure functions)
  _lib/discord.js       Discord webhook sender (strips pings, enforces embed limits)
  _lib/indexing.js      which responses search engines are allowed to index
  _lib/turnstile.js     server-side Turnstile verification, shared by abusable endpoints
  verify-premium.js     POST sign-in (cookie issuance) / GET session check
  auth-google.js        "Sign in with Google" convenience layer on verify-premium
  logout-premium.js     cookie clear
  check-member-status.js public membership probe (generic answers)
  stock-research.js     public quote snapshot (Alpaca IEX)
  premium-stock-research.js gated quote snapshot
  premium-market-analyst.js gated AI trend analyst (members-only per owner request)
  yahoo-news.js         sanitized headlines (Yahoo JSON search endpoint, not RSS — retired)
  forex-calendar.js     weekly economic calendar w/ explicit unavailability
  research-engine.js    (codex) premium research modules + snapshots
  content.js            GET owner-curated CMS tables (announcements, bundles, schedule, …)
  content-sync.js       cron-only pull from the Apps Script bridge into D1
  whop-webhook.js       Whop → entitlement automation (HMAC-verified, no rate limit)
  analytics.js          first-party funnel collection
  assistant.js          course-companion chatbot backend
  live-stats.js         auto-updating headline numbers (replacing hand-typed copy)
  market-brief.js       Pre-Market Brief (cached)
  ticker.js             homepage ticker tape data
  newsletter/subscribe.js, newsletter/unsubscribe.js
apps-script/
  content-sync/  hourly Sheet → D1 bridge (announcements, trade reviews, prop firms, schedule, team, bundles)
  member-sync/   authenticated single-record sheet bridge
migrations/            D1 schema (8 files: research, security, content platform, whop, entitlements, analytics, newsletter)
tests/                 node:test suites (auth, contracts, structure, research)
_headers               CSP/HSTS/etc for static assets
```

## Session design

Opaque HMAC-signed token `{v, mr(member-ref hash), dn(display name), t(tier),
sv(entitlement epoch), src(d1|sheet), exp}` in the `__Host-vjm_session` cookie
— the `__Host-` prefix is browser-enforced (Secure, Path=/, no Domain), so a
subdomain or sibling site can't plant or override it. `SESSION_VERSION` is `2`
(entitlements.js) since `t`/`sv`/`src` were added for tier-aware sessions;
`mr` is a truncated SHA-256 of the code — codes never ride in cookies.
Revocation is live today via `sv`, not a future table: bumping a member's
`whop_codes.session_epoch` column (webhook-driven on cancel) invalidates
every outstanding cookie for that member the next time `sessionEntitlementCheck()`
compares it against the cookie's `sv` claim — see session.js.

## Data ownership

- **D1**: entitlement state incl. epoch-based session revocation (live — see
  Session design), audit events, rate limits, research snapshots/metadata.
- **Google Sheet**: owner-managed membership roster via authenticated bridge.
  View layer, not public storage.
- **Alpaca**: market data, keys server-side only.
- Static content: stays in HTML until the content-system phase.

## Domain

Canonical: `not-financial-advice-vjm.com` (hyphenated) — pinned by
`functions/api/_lib/indexing.js`'s `CANONICAL_HOST`, robots.txt's
`canonical-origin:` line, sitemap.xml, and every page's canonical/OG tags.
`tests/indexing.test.mjs` explicitly rejects the un-hyphenated variant as a
non-canonical host. Set `RESEARCH_REFRESH_URL` to the hyphenated form (see
DEPLOYMENT).

## Target IA (post-rebuild phases)

Public: Home · Results · About · Options Lab · Stock Lab · Calendar · Blog · Premium overview · Discord CTA
Member (session): Dashboard · Blueprint courses · Research Engine · Advanced labs · Journal · Saves · Settings
Admin (server-auth): claims/content mgmt · member view · moderation · data health · audit log
