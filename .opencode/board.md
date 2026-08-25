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
