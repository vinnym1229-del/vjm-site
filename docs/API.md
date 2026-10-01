# API Reference

Base URL: `https://not-financial-advice-vjm.com` (canonical; matches
`functions/api/_lib/indexing.js`'s `CANONICAL_HOST`, robots.txt, and
sitemap.xml — see MASTER-AUDIT §F-BR4 for the historical ambiguity this
settled).
All responses are JSON with `Cache-Control: no-store`. Errors use stable shapes:
`{ "ok": false, "error": "<public message>" }` — internal details are never leaked.

## POST /api/verify-premium

Signs in a member. Sets `__Host-vjm_session` cookie: `Path=/; HttpOnly; Secure; SameSite=Lax`.

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

## POST /api/auth-google

"Sign in with Google" — a convenience layer on top of the access-code system
above, not a replacement (`premium-guidance.html`'s Google button; the code
box still works if it's never configured). Matches the Google account's
verified email against `whop_codes` and, on a live match, sets the same
`__Host-vjm_session` cookie `/api/verify-premium` does.

Request: `{ "credential": "<Google ID token>" }`
- 200 → `{ ok:true, expiresAt:"ISO", discord:"name|null", plan:"name|null" }` + Set-Cookie
- 400 → missing or oversized (>4096 char) credential
- 401 → the Google token failed verification (bad signature/audience/issuer/
  expiry against `GOOGLE_CLIENT_ID`) or the account's email isn't verified
- 404 → no `whop_codes` row's email matches this account at all
- 403 → a matching row exists but every one is expired or revoked — kept
  distinct from 404 for the same reason verify-premium's 403 is
- 429 → rate limited (10/min/IP)
- 503 → `GOOGLE_CLIENT_ID`, `SESSION_SIGNING_SECRET`, or `RESEARCH_DB` not configured
- 502 → unexpected failure

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

## GET /api/premium-market-analyst?years=1|3|5

Premium session cookie only (no legacy Bearer path); 401 with none, 403 `code:"upgrade_required"`
if the session's tier doesn't include The Trifecta. Deterministic trend metrics computed
server-side from Alpaca IEX daily bars for QQQ (Nasdaq-100 proxy) over the requested lookback,
then a Workers AI narrative grounded only on those metrics — no advice, no price predictions.
`years` defaults to 3; any other value 400s. `{ ok, symbol, label, years, coverage,
metrics:{totalReturnPct,cagrPct,maxDrawdownPct,vol30AnnualizedPct,sma50,sma200,lastClose,
aboveSma50,aboveSma200,momentum:{m1,m3,m6,m12},from52wHighPct,upDayRatioPct}, narrative,
narrativeEngine, dataOnly, source, disclaimer }`. `dataOnly` is true when the Workers AI
narrative failed and only the metrics survived. 502 on upstream history failure, 503 if
Alpaca unconfigured, 429 rate limited (6/min).

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
Feed URL overridable via `FOREX_CALENDAR_SOURCE_URL` (see docs/DEPLOYMENT.md) — omit it
and the default public feed above is used.

## GET /api/ticker

Live tape data behind the homepage ticker (`assets/live-ticker.js`, polled every 10s).
No params. Equities/ETFs (QQQ, SPY, DIA, IWM, GLD, USO, AAPL, TSLA, NVDA, MSFT) and BTC
come from Alpaca's IEX/crypto feeds — real-time, unlike the anonymous TradingView embed's
delayed "D"-badge data. 200 `{ ok:true, items:[{symbol,label,price,changePct,asOf,tv,asset}],
asOf, feed:"iex" }` on success; 200 `{ ok:false, pending:true, error }` when Alpaca isn't
configured (a normal "not wired up" state, not an error — the front-end falls back to the
TradingView tape); 200 `{ ok:false, error }` on upstream failure. 429 rate limited (60/min).
`Cache-Control: public, max-age=10, s-maxage=10` (shared edge cache absorbs polling across
visitors).

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

## GET /api/assistant

Members-only lesson catalogue for the course-companion chatbot
(`functions/api/assistant.js`). 401 if signed out. 200
`{ ok:true, lessons:[{id,version,title,course,level,resource,sections:[{id,heading}]}],
coverage:{wired,note} }` — `lessons` is filtered to what the caller's tier is entitled
to via `authorizeResource`, and `coverage.note` says out loud that the catalogue is a
subset of the full curriculum, not the whole thing. 429 rate limited (30/min).

## POST /api/assistant

Two modes on one endpoint, chosen by whether `lessonId` is present:
- `{ question }` — ungated market Q&A grounded on live Alpaca snapshots/movers via
  Workers AI. 200 `{ ok:true, mode:"grounded"|"data-only"|"data-unavailable", narrative,
  disclaimer }`; never narrates a number it doesn't actually have — falls back to
  `data-only` (raw data, no AI text) or `data-unavailable` instead of guessing.
- `{ question, lessonId, lessonVersion }` — session-gated course companion. Answers only
  from the server-owned lesson text for `lessonId`, never from text the browser sends.
  401 no session; 403 wrong tier (`{required}`, same tier table that gates the course
  pages); 404 unknown lesson; 409 stale `lessonVersion` (page must reload and re-fetch
  the catalogue); 200 `{ ok:true, mode:"lesson"|"lesson-unsupported", narrative,
  citation:{sectionId,heading} }` — refuses with `lesson-unsupported` rather than answer
  if the model's reply can't be tied back to a real cited section of that lesson.

429 rate limited (8/min). 502 on generation failure.

## Data classification vocabulary

Every data-bearing response carries `mode`/`precision`/`asOf` from:
`observed` · `observed + modeled` · `indicative` · `cached` · `unavailable`.
UI must render these labels next to values.
