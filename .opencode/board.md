# Board — Live Task Coordination

Every instance: claim before you edit, update when you finish. Rows move
Queued → Claimed → Done (or Blocked). Newest claims at top of their section.

## Active claims

| Instance | Branch | Scope (exact files/area) | Intent | Since |
|----------|--------|--------------------------|--------|-------|
| — | | | | |

## Queued (unclaimed, safe to take)

| # | Scope | Notes |
|---|-------|-------|
| 0 | docs/PJ-REDESIGN-BRAINSTORM.md | MASTER PLAN: futures-first redesign per owner Whop screenshots. Phase 1+2 DONE; remaining: Phase 3 CMS backend PR (owner-gated), Phase 4 starter-course funnel + analytics |
| 1 | owner assets | Video (≤25MB at assets/pj-intro.mp4 or YouTube URL), team bios/photos for the 5 blank slots, results-wall screenshots, $129 tier's Whop product URL if separate |

## Done

| Instance | Scope | Result | Date |
|----------|-------|--------|------|
| claude (autonomous maintenance run) | pj: tests/verify-premium-api.test.mjs | 73/73 tests green going in; live-deployment curl probe again unavailable (same standing network-policy 403 on pj.vjm.pages.dev, not re-logged as a new finding). Full sweep found nothing else broken. verify-premium.js — the exact endpoint the probe's own step 2 curl check targets — was the last auth-critical functions/api/*.js file with zero test references, so added a unit test that pins the same "bad code + no turnstileToken → verification-failed" contract at the code level, plus soft-required-until-configured, fail-closed on a Turnstile network error, and the token never appearing in the JSON body. Confirmed the fail-closed assertion fails when turnstile.js's catch block is flipped to return true (fail open) instead of false; reverted. 74/74 tests; commit pushed to origin/pj. | 2026-08-29 |
| claude (autonomous maintenance run) | pj: tests/auth-google-api.test.mjs | 71/71 tests green going in; live-deployment curl probe again unavailable — same standing network-policy block on pj.vjm.pages.dev (re-confirmed via agent-proxy status, no new info, not re-logged as a separate finding). Full sweep found nothing broken. auth-google.js was now the only auth-adjacent functions/api/*.js file with zero test references; its own comment already documents a real fixed bug (Google tokeninfo returns email_verified as the STRING 'true'/'false', so a naive `=== false` check let unverified accounts through) but nothing pinned that fix. Added tests/auth-google-api.test.mjs: config-missing 503s, malformed-body 400s, the email_verified string regression, aud-mismatch rejection, no-Whop-match 404, and the yearly-plan session-expiry cap. Confirmed the key test fails by reverting the check to `=== false`, watched it fail (404 instead of 401), reverted. 72/72 tests; commit pushed to origin/pj. | 2026-08-29 |
| claude (autonomous maintenance run) | pj: tests/member-status-api.test.mjs | 70/70 tests were green going in; live-deployment curl probe (step 2 of the run cycle) could not execute — this sandbox's network policy 403s all CONNECT attempts to pj.vjm.pages.dev, confirmed via the agent-proxy status endpoint, so that step is unverifiable from this environment rather than evidence of a site problem. No broken pages, dead links, heading-order/label/contrast gaps, or copy errors found on a full sweep (prior runs already closed those). Picked test coverage: check-member-status.js was the only functions/api/*.js file with zero test references, and its own comment promises callers can't tell an inactive handle from an unknown one — added tests/member-status-api.test.mjs covering 400/503/200/404 paths and asserting a known-inactive vs never-seen handle return byte-identical messages; confirmed the test fails if that promise is broken (temporarily patched the source, watched it fail, reverted). 71/71 tests; commit 33fb62e pushed to origin/pj. | 2026-08-29 |
| Codex /root | pj: index.html; tests/pj-futures.test.mjs; assets/pj-intro-poster.jpg | Replaced the generic thumbnail with PJ's own opening video frame, simplified the futures tape, and extended the red/black lightning gradient across sections; 56/56 tests pass. | 2026-08-27 |
| claude-code | pj: index.html - fixed opencode's local UI batch before commit (nav-highlight, premium dropdown, quiz, review-bars, growth/tick/sizing sims, hero video) | Found and fixed real breakage before pushing: #results left unclosed (results-grid deleted, nested #schedule inside it), Futures Tick Calc's <select id="fc-contract"> deleted leaving orphaned <option>s + unmatched closing div, and 4 new sim buttons (runGrowthSim/runPropPayout/calcTickSim/calcSizingSim) had zero matching JS - implemented all four (bidirectional NQ/MNQ/ES/MES point math for tick/sizing, daily-target x days/week/month for prop payout), fixed setSimMode's stale investing->prop ids, removed dead calcOptions/calcRR, removed a duplicate eager <video autoplay> in the hero (same file as the existing tested lazy facade), fixed review-bar fill (span width:% is ignored without display:block - real pre-existing bug). Added assets/pj-intro.mp4 (compressed, 16.1MB). 58/58 tests, verified all 4 calc functions + fill fix live via local server; commit 4391d4b, pushed to origin/pj. | 2026-08-25 |
| claude-code | pj: Phase 3 CMS expansion (schedule/team/faqs/bundles/stats/results) + _headers | integrations-core.js sanitizers + CONTENT_TYPES, content.js TYPES set, Code.gs reads 6 new sheet tabs, index.html client renderers for all 6 types (fallback markup kept, only replaced when CMS has rows; schedule renderer also refreshes PJ_SESSIONS times), _headers appended /pj noindex + immutable asset caching; 56/56 tests (10 new), verified against a local static server with /api/content 404ing - all fallbacks render correctly, no console errors; commits c2e8550 + 4f68139, pushed to origin/pj. Did NOT touch Tasks 1/2/5 (Cloudflare/GitHub secrets, wrangler, Lighthouse) - need owner credentials. | 2026-08-25 |
| ox-alpha | pj: index FX + team blanks + results wall + premium-market-analyst.js + ai.js guardrails + guidance panel | Ambient FX within perf budget (Perf 67/CLS 0 after trimming hero text-shimmer), PJ + 5 blank team slots, blank owner-ready results wall, premium Alpaca AI analyst (1/3/5Y QQQ, gated, data-grounded), chatbot now directs visitors; 46/46 tests, browser checks clean; commit c2f07f8; /pj synced (main 0e5dbd9) | 2026-08-24 |
| ox-alpha | pj branch: index/premarket + tests (Phase 1+2 in one pass) | Futures-first redesign: $100 Futures + $129 All-Markets bundles, Whop showcase (features/reviews/49,136), video facade above bundles, team of 5, week schedule grid + session countdown, FAQ + JSON-LD, socials, futures ticker; 44/44 tests, 14/14 browser checks, Perf 69 CLS 0; commit 6afa0c5; /pj preview synced on main ccf1516 | 2026-08-24 |
| ox-alpha | pj branch: index/premium-guidance/prop-firms + assets | Visual polish pass, scroll-reveal, chatbot wiring, lesson companion, prop-firms accuracy comments; tests 34/34; commit 6fb2dfc | 2026-08-24 |
| ox-alpha | main branch: /pj folder | Refreshed static preview from pj HEAD, noindex hygiene; commit 528cf58 | 2026-08-24 |

## Requests (cross-instance needs)

| From | Need | For |
|------|------|-----|
| — | | |

## Blocked on owner

| Item | What's needed |
|------|---------------|
| Pre-market brief auto-post | GitHub secrets RESEARCH_REFRESH_URL + RESEARCH_CRON_SECRET |
| Announcements → Discord auto-post | Cloudflare vars DISCORD_ANNOUNCEMENTS_WEBHOOK + CONTENT_DISCORD_DRYRUN=false |
| Whop purchase codes | WHOP_WEBHOOK_SECRET + D1 binding + DISCORD_WHOP_CODES_WEBHOOK |
