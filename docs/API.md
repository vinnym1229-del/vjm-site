# API Reference

Base URL: `https://not-financial-advice-vjm.com` (canonical; matches
`functions/api/_lib/indexing.js`'s `CANONICAL_HOST`, robots.txt, and
sitemap.xml — see MASTER-AUDIT §F-BR4 for the historical ambiguity this
settled).
Most responses are JSON with `Cache-Control: no-store`; a few read-only,
non-session endpoints are cached briefly instead — `/api/ticker`,
`/api/content`, and `/api/live-stats` each note their own value below. Errors
use stable shapes: `{ "ok": false, "error": "<public message>" }` — internal
details are never leaked.

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

## POST /api/whop-webhook

Whop → site entitlement automation. Not member-facing; Whop calls this
directly on a purchase, renewal, or cancellation. Verifies HMAC-SHA256 over
the raw body (`x-whop-signature`, keyed on `WHOP_WEBHOOK_SECRET`) and
`x-whop-timestamp` freshness (5-minute window), then dedupes by event id so a
retried delivery is a no-op.
- Grant: resolves the product/plan to an entitlement tier (`_lib/entitlements.js`);
  an unrecognized product grants nothing. Mints a VJM-XXXX-XXXX code, stores
  only its hash, and provisions `status='active'` immediately — access does
  not wait on anyone copying a code anywhere. Posts the plaintext code to the
  owner-only `DISCORD_WHOP_CODES_WEBHOOK` as a notification, not a gate; an
  undelivered code only rolls the grant back when the member has no email on
  file (their only way in), since one with an email can already sign in with
  Google.
- Renewal: Whop fires the same grant event on every recurring charge. The
  member's original code still works; the fresh code/row is a spare.
- Revoke: flips the member's rows to `status='revoked'` and bumps
  `session_epoch`, which invalidates cookies already issued — not just the
  next sign-in.
- 200 → `{ ok:true, ... }` (includes no-ops: ignored event, duplicate
  delivery, unrecognized product)
- 400 → malformed JSON · 401 → missing/stale/invalid signature
- 413 → body over 64KB · 422 → revoke event with no member id
- 503 → `WHOP_WEBHOOK_SECRET`/`RESEARCH_DB` not configured, or code
  generation exhausted its retries (Whop's own retry will mint a fresh one)

Env: `WHOP_WEBHOOK_SECRET` + `RESEARCH_DB` required, `DISCORD_WHOP_CODES_WEBHOOK` optional.
No rate limit — delivery is HMAC-verified, not public.

## GET /api/stock-research?symbol=TSLA

Alpaca IEX snapshot. `{ ok, symbol, source:{feed}, mode:"observed", precision, asOf,
quote:{price,change,changePercent,volume,vwap,prevClose,marketCap:null} }`
`marketCap` is always null on the free tier (no shares-outstanding source) — the UI omits it rather than showing stale values. 503 when Alpaca unconfigured, 502 if the upstream call or snapshot parse fails, 429 rate limited (30/min).

## GET /api/premium-stock-research?symbol=TSLA

Same payload shape as above but requires a premium session (cookie or legacy Bearer). 401 with
none, 403 `code:"upgrade_required"` if the session's tier doesn't include The Trifecta.
503 when Alpaca unconfigured, 502 if the upstream call or snapshot parse fails, 429 rate limited (30/min).

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
502 with explicit unavailable state on feed failure — no placeholder items. 429 rate limited (30/min).

## GET /api/forex-calendar?currency=USD&impact=major|high|medium

ForexFactory weekly calendar (public feed), USD high/medium events, ≤120 rows.
`impact` defaults to `major` (red + orange folders combined); `high` is red-folder-only,
`medium` is orange-folder-only. Any other value 400s.
`{ ok, events:[{title,currency,date(ISO),impact,forecast,previous,actual}], source, notice }`
Actual values appear only after release. 502 explicit-unavailable on failure. 429 rate limited (30/min).
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
`discordPosted:false`, if not). `movers`' default universe (SPY, QQQ, NVDA, AAPL, MSFT, TSLA,
AMD, META, AMZN, GOOGL) can be overridden with `BRIEF_UNIVERSE`, a comma-separated ticker
list (needs ≥2 valid entries or the default silently applies). `{ ok, stored, discordPosted,
discordDetail, brief }`; 502 on generation failure.

## GET /api/research-engine?module=health|options|intraday|stock|sectors|biotech

Premium-gated research (cookie session or `X-Research-Cron`). See
docs/research-engine-setup.md for module parameters. Health exposes booleans only.
Data modules (options/intraday/stock/sectors/biotech): 401 with no session, 403
`code:"upgrade_required"` if the session's tier doesn't include The Trifecta, 503 if Alpaca
unconfigured. On a live-fetch failure, serves the latest saved snapshot (`cached:true`) when
one exists in `RESEARCH_DB`, otherwise 502. 429 rate limited (30/min) — also guards the
premium-token check against brute-forcing.

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

## GET /api/content?type=announcements|trade_reviews|prop_firms|schedule|team|faqs|bundles|stats|results

Public read over owner-managed site content synced from the owner's Google Sheet
(see `functions/api/content-sync.js`, the cron-only bridge that populates this table —
not itself a public route). `trade_reviews` additionally accepts `&ticker=TSLA` to
filter. `{ ok:true, type, count, items, note, fetchedAt }`. `announcements` sorts
pinned items first; `team`/`faqs`/`results` sort by each item's own `order` field.
400 on an unknown `type` (lists `supported`). 503 if D1 binding `RESEARCH_DB` isn't
configured. 429 rate limited (120/min). `Cache-Control: public, max-age=60`.

## POST /api/analytics

First-party funnel telemetry (`assets/funnel.js`), built in-house instead of
a third-party vendor tag so visitor data never leaves this account. Records
no IP, user agent, or member-identifying data; `visit` is a random per-tab
id, not stable across tabs/sessions/devices.

Request: `{ visit:"<per-tab id>", events:[{name, path, props}] }`, up to 25 events
per batch. `name` must be one of a fixed allowlist of funnel stages (e.g.
`free_course_start`, `plan_cta`, `quiz_complete`) — anything else is silently
dropped, not stored. `props` keeps only small primitive values, ≤12 keys, ≤512 JSON
chars total once encoded.
- 200 → `{ ok:true, stored:<n> }` — `stored:0` is normal when every event in the
  batch was dropped as unrecognized, not an error
- 400 → invalid JSON, no events, or batch over 25
- 429 → rate limited (120/min)
- 503 → D1 binding `RESEARCH_DB` not configured
- 502 → storage write failed

## POST /api/newsletter/subscribe

The only endpoint that stores a personal identifier from an anonymous
visitor, so it validates and rate limits rather than trusts. A signup is an
UPSERT on the address (never a duplicate row), consent (`body.consent === true`)
is a required precondition rather than inferred, and Turnstile is enforced
once `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` are set.

Request: `{ email, firstName?, source?, consent:true, turnstileToken? }`
- 200 → `{ ok:true, subscribed:true }` — identical whether the address was
  already on the list or not (never an email-existence oracle)
- 400 → invalid/missing email, or `consent` not `true`
- 403 → Turnstile check failed · 429 → rate limited (10/min)
- 503 → `RESEARCH_DB` not configured · 502 → write failed

## GET /api/newsletter/subscribe

What the signup form needs before it can submit: `{ ok:true, required:<bool>,
siteKey:<public Turnstile site key>|null }`. `required:true, siteKey:null` is
the one dangerous misconfiguration (secret set, site key missing) — reported
so the form can say so on load instead of rejecting every signup silently.

## POST /api/newsletter/unsubscribe

Two ways in: a per-subscriber `token` (64 hex chars, from an email footer —
what a `List-Unsubscribe` header points at) or a typed `email` for someone
who deleted the mail. Never deletes the row; flips `status='unsubscribed'`
so the address stays a suppression entry. Looser rate limit than signup —
opting out must not be blockable from a shared IP.
- 200 → `{ ok:true, unsubscribed:true }` — identical whether or not the
  address/token matched anything
- 400 → neither token nor a valid email given
- 429 → rate limited (30/min) · 503 → `RESEARCH_DB` not configured

## GET /api/newsletter/unsubscribe?token=…

One-click unsubscribe (RFC 8058) for mail clients and plain links — no JS,
no form, no confirmation step. A deliberate state change on a GET: an extra
confirm-click step is a step people abandon. Redirects to
`/unsubscribe.html?state=done|invalid|error`.

## GET /api/live-stats

Auto-updating headline numbers (Discord member/online count, Whop member/review
count) behind the homepage hero badge and mobile sticky CTA, replacing hand-typed
figures. Discord side needs no config (public invite endpoint for `pjtrades`); Whop
side needs `WHOP_API_KEY` + `WHOP_PRODUCT_ID` and falls back to the page's static
numbers (never breaks the page) if either is missing.
`{ ok:true, discord:{memberCount,onlineCount}|null, whop:{memberCount,reviewCount}|null,
asOf }`. 429 rate limited (60/min). `Cache-Control: public, max-age=300`.

## Data classification vocabulary

Every data-bearing response carries `mode`/`precision`/`asOf` from:
`observed` · `observed + modeled` · `indicative` · `cached` · `unavailable`.
UI must render these labels next to values.
