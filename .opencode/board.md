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
| 0 | docs/PJ-REDESIGN-BRAINSTORM.md | MASTER PLAN: futures-first redesign per owner Whop screenshots. Execute in the doc's phase order; §15 questions gate exact copy only |
| 1 | index.html premium dashboard tab | Fix "$50/mo launch rate" copy vs actual price (subsumed by Phase 1 truth sweep) |
| 2 | index.html ticker block | Swap to NQ/ES/MNQ/MES futures tape (subsumed by Phase 1) |
| 3 | prop-firms.html + tokens.css | Client-side stale-while-revalidate cache for /api/content |
| 4 | team section (index.html) | Power "Meet the Team" from Sheets CMS (Phase 3, needs backend PR) |
| 5 | functions/api/_lib/ai.js ⚠ backend | Owner approval needed: expose model string config for smarter Workers AI models |
| 6 | Phase 1 truth sweep (index.html, premarket.html, meta) | $129→$100 + 3 bundles, FAQ verbatim, stats, socials, futures-first nav/copy — brainstorm §11 checklist |
| 7 | Phase 2 sections | Video slot (hosting TBD §2), Meet the Team, CMS-shaped schedule grid + countdown rewrite |
| 8 | Phase 3 backend PR ⚠ owner-gated | content-sync + integrations-core: new tabs schedule/team/bundles/faqs/media/testimonials/stats |

## Done

| Instance | Scope | Result | Date |
|----------|-------|--------|------|
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
