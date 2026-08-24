# Architecture

## Current shape (kept deliberately)

Static HTML/CSS/JS on **Cloudflare Pages** + Pages Functions under
`functions/api/**` (file-routed). D1 optional via bindings. GitHub Actions cron
refreshes research snapshots. Apps Script bridges owner's Google Sheet to a
server-to-server lookup API.

Decision: **no framework migration in this pass.** Evidence: the monolith
problem is concentrated in one file (index.html ~2.4 MB); auth/data integrity
were the burning risks, not tooling. A Vite/Astro split is designed (below)
but gated on the homepage rebuild phase so it lands with new structure instead
of churning working pages twice.

## Module map

```
functions/api/
  _lib/session.js      HMAC session tokens, cookie builders, secret resolution
  _lib/http.js         JSON envelope, rate limiter, symbol validation, fetch helper
  verify-premium.js    POST sign-in (cookie issuance) / GET session check
  logout-premium.js    cookie clear
  check-member-status.js public membership probe (generic answers)
  stock-research.js    public quote snapshot (Alpaca IEX)
  premium-stock-research.js gated quote snapshot
  yahoo-news.js        sanitized RSS headlines
  forex-calendar.js    weekly economic calendar w/ explicit unavailability
  research-engine.js   (codex) premium research modules + snapshots
apps-script/member-sync/  authenticated single-record sheet bridge
migrations/            D1 schema (research + security tables)
tests/                 node:test suites (auth, contracts, structure, research)
_headers               CSP/HSTS/etc for static assets
```

## Session design

Opaque HMAC-signed token `{v, mr(member-ref hash), dn(display name), exp}` in
`vjm_session` cookie. Server holds no session table yet; revocation denylist is
the next step (D1 `sessions` table designed in MASTER-AUDIT §14 target model).
`mr` is a truncated SHA-256 of the code — codes never ride in cookies.

## Data ownership

- **D1**: sessions/revocation (planned), audit events, rate limits, research
  snapshots/metadata.
- **Google Sheet**: owner-managed membership roster via authenticated bridge.
  View layer, not public storage.
- **Alpaca**: market data, keys server-side only.
- Static content: stays in HTML until the content-system phase.

## Domain

Canonical: `notfinancialadvicevjm.com` (matches CNAME). The hyphenated variant
in INSTALL-FIRST.md is flagged; owner confirms which domain Cloudflare serves
and sets `RESEARCH_REFRESH_URL` accordingly (see DEPLOYMENT).

## Target IA (post-rebuild phases)

Public: Home · Results · About · Options Lab · Stock Lab · Calendar · Blog · Premium overview · Discord CTA
Member (session): Dashboard · Blueprint courses · Research Engine · Advanced labs · Journal · Saves · Settings
Admin (server-auth): claims/content mgmt · member view · moderation · data health · audit log
