# VJM / St Trades — Master Audit (evidence-based)

Audit date: 2026-08-23 · Auditor branch: `codex/platform-hardening` (cut from `origin/codex/vjm-research-engine`)
Method: direct inspection of all branches, blobs, and working tree. Every claim below cites a file/line or git object.

---

## 1. Branch & deployment audit

| Branch | Last commit | Contents |
|---|---|---|
| `claude/nlm-fvg-ifvg-bpr-2l0bhm` **(remote default!)** | 12c2642 2026-08-06 | Pine Script indicator (`NLM.pine`) + README only. **No website files.** |
| `main` | 9945bb9 2026-08-12 | Full static site, 2 Pages Functions, no research engine |
| `codex/vjm-research-engine` | c61573d 2026-08-22 | `main` + research engine (API, D1 migration, tests, refresh workflow, docs) |

Findings:
- **F-BR1:** The GitHub default branch is a Pine Script branch that does not contain the website. Anyone cloning the repo or opening a Cloudflare Pages connection pointed at the default gets no site. → Recommendation: reset default to `main` after consolidation (owner action in GitHub Settings; cannot be done via git push).
- **F-BR2:** `codex/vjm-research-engine` is a fast-forward superset of `main`; the claude branch shares nothing with the site. Consolidation = build on codex. No destructive merge needed.
- **F-BR3:** Local worktree before this audit held untracked copies of every site file, byte-identical (`git hash-object`) to `origin/main`. No local-only owner work existed. The nested `vjm-site/vjm-site/` folder is a duplicate ZIP artifact (NLM.pine + README only) — left untouched.
- **F-BR4 (domain):** `CNAME` = `notfinancialadvicevjm.com` (no hyphens), but `INSTALL-FIRST.md` instructs `RESEARCH_REFRESH_URL=https://not-financial-advice-vjm.com` (hyphenated). Two canonical domains are in circulation. All canonical tags, OG URLs, sitemap, OAuth callbacks must use ONE domain. Owner must confirm which resolves in Cloudflare; code below standardizes on the CNAME value.

## 2. Frontend → API contract audit

Verified by scanning every `fetch(` call in shipped HTML vs existing Functions:

| Frontend calls | Used by | Backend exists? | Status |
|---|---|---|---|
| `POST /api/verify-premium`, `GET /api/verify-premium?token=` | index, stock-lab, premium-guidance, research-engine.js | ✅ `functions/api/verify-premium.js` | Insecure (see §3) |
| `GET /api/check-member-status?discord=` | index.html:2662 | ✅ `functions/api/check-member-status.js` | Enumeration risk (see §3) |
| `GET /api/forex-calendar?currency=USD&impact=major` | forex-calendar.html:60 | ❌ **MISSING** | Page shows perpetual "loading" then dead state |
| `GET /api/yahoo-news?symbol=` | stock-lab.html:59 | ❌ **MISSING** | News always falls to "unavailable" path |
| `GET /api/stock-research?symbol=` | stock-lab.html:60 | ❌ **MISSING** | Quote block always "unavailable" |
| `POST /api/logout-premium` | stock-lab.html:63 | ❌ **MISSING** | Sign-out silently 404s; localStorage cleared client-side only |
| `GET /api/research-engine?module=…` | research-engine.html/assets/research-engine.js | ✅ codex branch | OK, bearer-token model |
| `iframe src=/premium-screener.html` | stock-lab.html:63 (`showPremium()`) | ❌ file does not exist on any branch | Premium gate unlocks into a broken iframe |

## 3. Security audit — priority-zero findings (all verified)

### P0-1 Hard-coded admin password in browser-delivered HTML
`index.html:2289`: `const ADMIN_PW = 'VINNY_ADMIN_01';` compared client-side at line 2381 (`if (val === ADMIN_PW)`). The entire admin panel (blog post editor, P&L entry panel unlock at 2384) is authorized by this comparison, i.e., by anyone who opens DevTools.
**Treat as permanently compromised.** Remediation: remove password + client-gated mutations entirely; ship server-authorized admin routes behind session cookies (implemented in this branch); rotate any reused credential.

### P0-2 Access codes reused as HMAC signing key
`functions/api/verify-premium.js:100` (`signingSecret()` returns `PREMIUM_ACCESS_CODES`, with a hard-coded fallback string `'st-trades-fallback-signing-secret'`). A *collection of member codes* is used as cryptographic key material; anyone who knows one valid code shape gains oracle access; the fallback means an unconfigured deploy signs tokens with a public constant. Session forgery = full premium bypass.
Remediation: dedicated `SESSION_SIGNING_SECRET`; refuse to sign without it (fail closed); codes never touch crypto.

### P0-3 Tokens in localStorage + URL query strings
Frontends store the session token in `localStorage` (`TOKEN_KEY`) and pass it back via `GET /api/verify-premium?token=…` (index:2317, stock-lab:63, premium-guidance:98). XSS exfiltration trivially yields account takeover; tokens leak into history/logs/referrers via URLs.
Remediation: HttpOnly; Secure; SameSite=Lax cookie sessions, server-side revocation support; URL token path removed.

### P0-4 Apps Script bridge exposes the entire member/code map
`check-member-status.js:36-53` fetches `MEMBERS_STATUS_URL` and reads `data.statuses` (a map of *every* username→status) and verify-premium reads `data.codes` (every code→member). The bridge URL responds to anyone who knows it with the full sheet. The Function keeps it server-side, but the upstream endpoint itself is unauthenticated and dumps the whole membership table to any visitor of that URL.
Remediation: versioned Apps Script source in-repo requiring signed server-to-server requests returning single records; old mode supported only until owner migrates.

### P0-5 Username/status enumeration
`/api/check-member-status` answers "Not Found" vs "Active" for any Discord handle (index.html member lookup), enabling bulk probing of membership. Code verification returns distinct "incorrect code" / "on file but not active" messages (verify-premium.js:48,54).
Remediation: generic public errors, rate limiting, audit hooks.

### P0-6 Client-side-only authorization elsewhere
Trade reviews unlock (`index.html:1694 checkReviewPassword`) compares against the same code client-side; premium dashboards toggle DOM visibility only. No server checks on content that matters. (Content currently ships static so impact is limited, but pattern is dangerous and was removed where present.)

### P0-7 No security headers
No `_headers` file exists → no CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors. Added in this branch (see `_headers`).

### P0-8 Git-history credential exposure
Searched all reachable blobs for secret-shaped strings (`ADMIN_PW`, signing fallback, code lists). Findings: the admin password and the HMAC fallback string above exist in reachable history on `main`/`codex`. No API keys/tokens found in tracked blobs (Alpaca keys were correctly kept out of the repo per codex docs).
**Rotation checklist (owner):** change the admin credential everywhere it was reused; issue new premium access codes if any may have leaked; set fresh `SESSION_SIGNING_SECRET`.

## 4. Data-quality audit

Fabricated/demo data found shipping as live-looking:

| Item | Location | Classification | Action |
|---|---|---|---|
| Simulated live viewer count | index.html:2524-2533 (`base=28` + sin/random jitter) | **fabricated** | Removed |
| "Launch spots" scarcity bar (`total=20, claimed=7 // update manually`) | index.html:2509-2522 | **fabricated urgency** | Removed |
| `$1,200 → $50K+ in 30 days` og:description/meta | index.html head | Unverifiable performance claim | Replaced with compliant description pending owner evidence |
| Hard-coded P&L/win values ($645×7, $53,991, $67,073 …) | index.html wins/account sections | Owner-managed content **without as-of dates/evidence states** | Kept visible but labeled owner-reported w/ disclaimer; flagged for structured system |
| Watchlist scores/status/why/catalyst fields | stock-lab WATCHLIST array | Owner-authored opinion rendered as analysis | Labeled "owner note — not a live score"; scores sorted but captioned |
| Stream countdown 9:15 AM–2:00 PM ET weekdays | index.html:2440+ | Real schedule logic (assumes US holidays = trading days — minor) | Kept, documented limitation |
| Testimonials/member count "300+" | meta/hero | Owner claim, no proof link | Retained pending managed-claims field |

Data-classification rule adopted repo-wide: every dynamic value carries `{source, asOf, freshness}`; unavailable ≠ zero; cached responses must say `cached:true`.

## 5. Structural/performance audit

- index.html = **2,496,321 bytes (~2.4 MB)**, 2,865 lines, minified CSS+JS inline. Confirmed monolith.
- Duplicate IDs (verified by extraction): index.html `theme-label`×4, `member-wins`×2; options-lab.html `theme-label`×4; premium-guidance.html `signin-title`×2. Fixed in this branch.
- Broken internal reference: `/premium-screener.html` (stock-lab) — no such file anywhere in history.
- Emoji-as-icon dependency throughout; base64/photographic weight concentrated in index.html hero/wins imagery.
- No package.json test runner wired to CI beyond ad-hoc node tests on codex; tests exist but don't cover auth/security.

## 6. What was preserved (do-no-harm list)

- Research Engine (codex): Alpaca SIP/BOATS/indicative handling, explicit proxy labeling, snapshot persistence, cron workflow — kept intact and extended, not rewritten.
- Options Lab / Stock Lab educational content and TradingView integration.
- All legal pages (privacy/terms/risk-disclosure) — updated only where integrations changed facts.
- Member status bridge compatibility during migration.

## 7. Remediation map (this branch)

See `docs/SECURITY.md` for control-by-control status and `docs/API.md` for the contract table after fixes.
