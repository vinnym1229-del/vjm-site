# API Reference

Base URL: `https://not-financial-advice-vjm.com` (canonical; matches
`functions/api/_lib/indexing.js`'s `CANONICAL_HOST`, robots.txt, and
sitemap.xml — see MASTER-AUDIT §F-BR4 for the historical ambiguity this
settled).
All responses are JSON with `Cache-Control: no-store`. Errors use stable shapes:
`{ "ok": false, "error": "<public message>" }` — internal details are never leaked.

## POST /api/verify-premium

Signs in a member. Sets `vjm_session` cookie: `HttpOnly; Secure; SameSite=Lax`.

Request: `{ "code": "ABCD-1234" }`
- 200 → `{ ok:true, expiresAt:"ISO", discord:"name|null" }` + Set-Cookie
- 401 → generic failure (malformed code, code D1 has never heard of, or the
  legacy Sheet-bridge fallback rejecting it — these stay indistinguishable so
  a bad guess can't be used to probe which codes exist)
- 403 → membership found in D1 but revoked or expired — a distinct message,
  since telling a lapsed customer to renew (rather than "check your code")
  only helps once they already possess a code we issued
- 429 → rate limited (10/min/IP)
- 503 → signing secret not configured

## GET /api/verify-premium

Session check from cookie only.
- 200 `{ ok:true, active:true, discord, expiresAt }` or `{ ok:true, active:false }`

## POST /api/logout-premium

Clears the session cookie. Always 200 `{ok:true}`.

## GET /api/check-member-status?discord=<handle>

Public membership probe.
- 200 `{ ok:true, active:true, message, checkedAt }`
- 404 `{ ok:true, active:false, message }` — same shape whether handle unknown or inactive
- 429 rate limited · 400 invalid handle · 502/503 upstream/config issues

## GET /api/stock-research?symbol=TSLA

Alpaca IEX snapshot. `{ ok, symbol, source:{feed}, mode:"observed", precision, asOf,
quote:{price,change,changePercent,volume,vwap,prevClose,marketCap:null} }`
`marketCap` is always null on the free tier (no shares-outstanding source) — the UI omits it rather than showing stale values. 503 when Alpaca unconfigured.

## GET /api/premium-stock-research?symbol=TSLA

Same payload shape as above but requires a premium session (cookie or legacy Bearer). 401 otherwise.

## GET /api/yahoo-news?symbol=TSLA (or ?topic=forex|futures|market)

Yahoo Finance JSON search-endpoint headlines (≤12), sanitized/deduped, cached ~5 min server-side.
Not RSS — Yahoo retired its RSS feed; `symbol` and `topic` are mutually exclusive, `topic` is a
closed allowlist mapped to a fixed query (used by forex-calendar.html's headline panel).
`{ ok, items:[{title,link,publisher,pubDate,description}], source, fetchedAt }`
502 with explicit unavailable state on feed failure — no placeholder items.

## GET /api/forex-calendar?currency=USD&impact=major|high|medium

ForexFactory weekly calendar (public feed), USD high/medium events, ≤120 rows.
`impact` defaults to `major` (red + orange folders combined); `high` is red-folder-only,
`medium` is orange-folder-only. Any other value 400s.
`{ ok, events:[{title,currency,date(ISO),impact,forecast,previous,actual}], source, notice }`
Actual values appear only after release. 502 explicit-unavailable on failure.

## GET /api/market-brief

Today's Pre-Market Brief (cached), the feed behind premarket.html. 200
`{ ok:false, pending:true, error, date }` until the scheduled morning POST has run for
the day — a normal "not generated yet" state, not an error; callers gate on `ok`/`pending`,
not the status code. Once generated: 200 `{ ok:true, module, date, generatedAt, lean,
proxies, movers, headlines, calendarEventCountToday, narrative, narrativeEngine, dataOnly,
warnings, disclaimer }`. `lean` is the same ETF-proxy heuristic as `/api/research-engine`'s
intraday module (low confidence); `dataOnly` is true when the Workers AI narrative failed
and only the raw data survived. 429 rate limited (30/min).

## POST /api/market-brief

Regenerates and stores the brief. Authorized by `X-Research-Cron` only (constant-time
compare against `RESEARCH_CRON_SECRET`, same pattern as research-engine's cron auth) —
401 otherwise. Optionally posts to `DISCORD_ANNOUNCEMENTS_WEBHOOK` if configured (dry-run,
`discordPosted:false`, if not). `{ ok, stored, discordPosted, discordDetail, brief }`;
502 on generation failure.

## GET /api/research-engine?module=health|options|intraday|stock|sectors|biotech

Premium-gated research (cookie session or `X-Research-Cron`). See
docs/research-engine-setup.md for module parameters. Health exposes booleans only.

## Data classification vocabulary

Every data-bearing response carries `mode`/`precision`/`asOf` from:
`observed` · `observed + modeled` · `indicative` · `cached` · `unavailable`.
UI must render these labels next to values.
