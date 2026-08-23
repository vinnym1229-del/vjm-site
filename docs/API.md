# API Reference

Base URL: `https://notfinancialadvicevjm.com` (canonical; see MASTER-AUDIT §F-BR4).
All responses are JSON with `Cache-Control: no-store`. Errors use stable shapes:
`{ "ok": false, "error": "<public message>" }` — internal details are never leaked.

## POST /api/verify-premium

Signs in a member. Sets `vjm_session` cookie: `HttpOnly; Secure; SameSite=Lax`.

Request: `{ "code": "ABCD-1234" }`
- 200 → `{ ok:true, expiresAt:"ISO", discord:"name|null" }` + Set-Cookie
- 401 → generic failure (unknown code and inactive code are indistinguishable)
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

## GET /api/yahoo-news?symbol=TSLA

Yahoo Finance RSS headlines (≤12), sanitized/deduped, cached ~5 min server-side.
`{ ok, items:[{title,link,publisher,pubDate,description}], source, fetchedAt }`
502 with explicit unavailable state on feed failure — no placeholder items.

## GET /api/forex-calendar?currency=USD&impact=major|medium

ForexFactory weekly calendar (public feed), USD high/medium events, ≤120 rows.
`{ ok, events:[{title,currency,date(ISO),impact,forecast,previous,actual}], source, notice }`
Actual values appear only after release. 502 explicit-unavailable on failure.

## GET /api/research-engine?module=health|options|intraday|stock|sectors|biotech

Premium-gated research (cookie session or `X-Research-Cron`). See
docs/research-engine-setup.md for module parameters. Health exposes booleans only.

## Data classification vocabulary

Every data-bearing response carries `mode`/`precision`/`asOf` from:
`observed` · `observed + modeled` · `indicative` · `cached` · `unavailable`.
UI must render these labels next to values.
