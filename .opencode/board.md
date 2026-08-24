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
| 1 | index.html premium dashboard tab | Fix "$50/mo launch rate" copy vs $129/mo actual price |
| 2 | index.html ticker block | Add loading="lazy" strategy to TradingView script for LCP |
| 3 | prop-firms.html + tokens.css | Client-side stale-while-revalidate cache for /api/content |
| 4 | team section (index.html) | Power "Meet the Team" from the Sheets CMS like prop-firms does |
| 5 | functions/api/_lib/ai.js ⚠ backend | Owner approval needed: expose model string config for smarter Workers AI models |

## Done

| Instance | Scope | Result | Date |
|----------|-------|--------|------|
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
