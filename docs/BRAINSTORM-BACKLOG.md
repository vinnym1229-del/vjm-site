# PJ Trades x St — Improvement Backlog

Living document. Every idea scored: **Impact** (H/M/L on business or member value) × **Effort** (H/M/L).
"Prereq" lists what must exist first. Owner-decision items are marked ⚑.

---

## 0. North star & strategy

The product wins if it does three jobs better than anything at this price:
1. **Teach** futures/options/stocks so simply it sticks (courses + academy + Edge Lab).
2. **Build trust through transparency** (tracked callouts, honest stats, no fake scarcity).
3. **Create a daily habit** (brief → quiz → journal → community) so $129/mo renews itself.

Funnels to instrument (privacy-friendly, no PII):
- **Acquisition:** visitor → free tool run → Discord click → free Discord → Whop trial → premium
- **Retention:** premium member → first lesson complete → 7-day activity streak → day-30 renewal

---

## 1. Acquisition (top of funnel)

| # | Idea | I | E | Notes / Prereq |
|---|------|---|---|----------------|
| 1.1 | Edge Lab public presets as shareable links (`/edge-lab?preset=gap-go&symbol=QQQ`) with OG images auto-rendered per result | H | M | Edge Lab; OG image fn via Workers AI? No — use SVG→PNG-free approach: share the *page*, rich embed via static OG per preset |
| 1.2 | "Does gap-and-go still work?" style blog posts auto-drafted from Edge Lab runs, owner-approved before publish | H | M | Edge Lab + content system; ⚑ approval workflow |
| 1.3 | Whop **free trial** link (native feature) as secondary CTA everywhere | H | L | ⚑ enable trial in Whop dashboard |
| 1.4 | Whop **affiliate program** for members (replaces deleted ST20 hack, done properly) | M | L | ⚑ enable in Whop; page explaining it |
| 1.5 | Glossary page: 100+ terms, "explain like I'm 5" toggles — SEO magnet | H | M | static content + search |
| 1.6 | FAQ page (pricing, refunds, what's included, prop firms, Discord) — support deflection + SEO | M | L | |
| 1.7 | Programmatic symbol pages (`/stocks/NVDA`): real quote + honest stats + Edge Lab link — only where data is live; 404-honest when not | M | M | stock-research fn; avoid thin content: include unique educational blurbs per sector |
| 1.8 | Comparison page: "PJ Trades vs $500/mo chat rooms vs $3k courses" — tasteful, no competitor names | M | L | ⚑ copy approval |
| 1.9 | YouTube/TikTok → tool deep-links: every video description links the exact Edge Lab preset shown | M | L | ⚑ PJ workflow |
| 1.10 | Referral dashboard: member gets personal Whop affiliate link + sees credited signups | M | M | Whop affiliate API? If unavailable: manual sheet |

## 2. Activation (first value fast)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 2.1 | **Onboarding checklist** on member dashboard: ① Connect Discord ② Watch Start-Here ③ Run your first Edge Lab scan ④ Set your risk % ⑤ Complete placement quiz — progress bar, server-tracked | H | M | courses + progress tables |
| 2.2 | Placement quiz routes members to futures/options/stocks track + recommended starting module | M | L | quiz exists; add routing logic |
| 2.3 | "First week plan" email/Discord DM series (needs bot or manual — ⚑) | M | M | |
| 2.4 | Timezone auto-detect: schedule page + brief times render in member's local time | M | L | Intl API, no storage needed |
| 2.5 | Empty-state excellence: every locked/premium surface shows exactly what unlocks it + trial CTA | M | L | copy pass |

## 3. Retention (habit loops — the $129 renewal engine)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 3.1 | **Daily market quiz** — 3 questions generated from that morning's brief data (Workers AI, cached). Streak counter, honest ("3-day streak"), no shame mechanics | H | M | market-brief data |
| 3.2 | **Member journal** (private, server-side): entries {date, symbol, setup, R, mistake tag, lesson link, screenshot→R2}, weekly review prompt "what's your one leak?" | H | M-H | R2 bind; export anytime; delete on request (privacy) |
| 3.3 | **Journal AI review (opt-in)**: "tag my last 20 entries for recurring mistakes" — Workers AI over member's OWN entries only; labeled heuristic; never advice | M | M | 3.2 |
| 3.4 | Weekly member recap DM/post: lessons completed, quiz streak, journal entries, one concept to review (spaced repetition pick) | M | M | needs Discord bot for DM; else dashboard card |
| 3.5 | **Spaced repetition deck**: glossary/concept cards resurfaced at intervals on dashboard ("Review: IFVG invalidation rules") | M | M | glossary content |
| 3.6 | Course completion certificates (meaningful: requires quiz pass ≥80%) — shareable image with verify-link | M | M | quiz infra |
| 3.7 | Streaks done honestly: activity streaks (lessons/quiz/journal), never "login streak" vanity | M | L | |
| 3.8 | "What's new" changelog page + in-Discord post on every deploy (workflow posts release notes) | M | L | CI webhook |
| 3.9 | Win-back: lapsed-member email/DM with "your journal export + what you missed" (⚑ ESP decision) | M | M | ESP cost decision |

## 4. Revenue expansion (all Whop-native unless noted)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 4.1 | **Annual plan** $1,290 (2 months free) — Whop native pricing option | H | L | ⚑ Whop setting; show both on join tab |
| 4.2 | Digital products: journal template, pre-market checklist PDF, watchlist template — Whop one-time purchases | M | L | ⚑ create products |
| 4.3 | Bootcamp bundles: 5-hr pack $450, 10-hr $800 (vs $100/hr) | M | L | ⚑ pricing approval |
| 4.4 | Prop-firm affiliate disclosures + tracked links (many firms run affiliate programs) | M | L | ⚑ sign up; disclose clearly |
| 4.5 | Team/office plan: "bring your desk" group rate | L | L | ⚑ |
| 4.6 | Gift a month (Whop gifting if available) | L | L | ⚑ |

## 5. Education product depth

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 5.1 | **Scenario simulator**: real historical morning (from daily/intraday bars) — member picks action at decision points; reveal path + outcome distribution; "what would the model say?" sidebar | H | H | intraday history depth on free tier is limited — label; daily-bar scenarios always available |
| 5.2 | **Chart drills**: random historical date, hide the future, member predicts up/down/close-in-range; track personal hit-rate vs base rate — teaches base-rate thinking honestly | H | M | daily bars |
| 5.3 | "Spot the setup" quiz bank: annotated historical charts (owner-curated screenshots in R2) with multiple choice + explanations | M | M | ⚑ PJ curates 20 to start |
| 5.4 | Lesson-level quizzes (planned) + **question bank per module** with randomized ordering, attempt history, explanations for every answer | H | M | courses v1 |
| 5.5 | Downloadable checklists per module (pre-market, journal review, risk check) — printable | M | L | |
| 5.6 | Interactive model playbook page: the continuation/reversal model as a step-through diagram with "when this fails" section | H | M | core IP; ⚑ PJ approves exact rules |
| 5.7 | Glossary tooltips inside lessons (dotted underline → popover) | M | M | glossary |
| 5.8 | Lesson transcripts + chapters for stream replays (if replays hosted on Whop/YouTube: embed + timestamps) | M | M | ⚑ hosting decision |
| 5.9 | "Fifth-grader mode" toggle: swaps jargon for plain-language sidebars (matches bootcamp positioning) | M | M | content pass |

## 6. Data & research tools (hedge-fund-lite, all honest-label)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 6.1 | **Gap statistics tool**: "How often does SPY fill today's gap, by size bucket?" — classic, computable, endlessly fascinating | H | M | daily bars; extend Edge Lab |
| 6.2 | **Seasonality explorer**: day-of-week / month / around-holiday return tables with sample sizes + Wilson CIs | H | M | daily bars |
| 6.3 | **Overnight vs open-to-close decomposition**: where does the return actually come from? (educational eye-opener) | M | M | daily bars |
| 6.4 | **Correlation matrix**: SPY/QQQ/sectors rolling 60d, hover details | M | M | snapshots history — needs daily collection job |
| 6.5 | **Breadth tracker**: % of universe above 20/50/200 SMA, computed from collected daily bars — real internals without paid feeds | M | M | 6.4 collector |
| 6.6 | **Volatility dashboard**: realized vol (10/20/60d), VIX level+term proxy from indicative options where available; regime labels (heuristic) | M | M | |
| 6.7 | **OI change tracker**: nightly snapshot diff of top contracts → "observed OI change" (only true after collection starts — label the start date!) | M | M | nightly cron + D1 |
| 6.8 | Earnings calendar — only if a reliable free source is found; else explicit "not available" (never fabricate dates) | M | L | source hunt ⚑ |
| 6.9 | **Callout tracker** ⭐: every public Discord callout logged by mods → site tracks outcome (win/loss/scratch/running) with survivorship disclaimers. Uncomfortable honesty = ultimate credibility | H | M-H | ⚑ PJ must commit to logging everything; moderation flow |
| 6.10 | Market regime banner on premarket page: trend/range/vol-expansion label from objective rules (published rules, labeled heuristic) | M | M | |

## 7. AI features (Workers AI free tier only)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 7.1 | Daily quiz generation from brief (3.1) — cache in D1, one generation/day | H | M | |
| 7.2 | "Explain like I'm 5" endpoint for any glossary term/lesson paragraph (rate-limited, grounded) | M | L | assistant.js pattern |
| 7.3 | Chart-screenshot coach (LLaMA vision on Workers AI): member uploads their chart → AI describes structure in educational terms, NEVER buy/sell; heavy disclaimers; rate-limited to premium | M | M-H | vision model neuron cost — measure first |
| 7.4 | Auto-draft weekly community recap post (owner approves → content system publishes) | M | L | |
| 7.5 | FAQ auto-suggestions from assistant logs (privacy-safe: only unmatched-question *topics*, owner-curated) | L | M | skip if logging feels creepy — default off |
| 7.6 | Headline classifier for the brief: macro / earnings / geopolitics tags (heuristic first, AI fallback) | L | L | |

## 8. Community & Discord depth

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 8.1 | Discord bot v1 (design exists): /vjm-status, /vjm-brief, /vjm-lesson — needs bot token ⚑ | H | M | docs/DISCORD-INTEGRATION.md |
| 8.2 | Discord OAuth "Connect" on dashboard → stable member identity, role-aware UI, course progress tied to Discord ID | H | M | bot + OAuth |
| 8.3 | Premium role reconciliation job (dry-run reports first) | M | M | 8.2 |
| 8.4 | Trade-review submission form → moderation queue (sheet tab "ReviewQueue") → approved items flow to public reviews | M | M | content system |
| 8.5 | Community highlights: weekly top insight/question pinned (mod-curated via sheet) | L | L | |
| 8.6 | AMA question collector page → sheet → PJ picks | L | L | |
| 8.7 | Course-progress roles (bot): "Futures Graduate" role on final-exam pass | M | M | 8.2 + quizzes |

## 9. Trust, compliance & brand

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 9.1 | **Performance policy page**: why we removed P&L screenshots; how we think about results; what we will never do (fake scarcity, cherry-picks) | H | L | ⚑ PJ voice |
| 9.2 | "What this is / what this isn't" cards on premium page (education ≠ advice; no signal-selling) | M | L | |
| 9.3 | Refund/cancellation page with exact steps (Whop self-serve) — reduces chargebacks, builds trust | M | L | ⚑ policy text |
| 9.4 | Risk quiz before first journal entry ("can you state your max loss?") — educational gate, not dark pattern | M | M | |
| 9.5 | New PJ Trades logo assets (AVIF/WebP + favicon) — current files are old brand | H | L | ⚑ owner provides |
| 9.6 | OG share images per page (static, branded) | M | L | |
| 9.7 | Accessibility audit to WCAG 2.2 AA on all new pages (axe in CI — already in prompt) | M | M | |
| 9.8 | Legal pages mention: Workers AI processing, Whop billing, Discord, journal data, retention + delete path | H | L | ⚑ final review |

## 10. Technical excellence

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 10.1 | **PWA**: manifest + service worker; offline course reading; installable "app" — zero app-store cost | H | M | |
| 10.2 | **Web push**: "Morning brief is live" opt-in notification (free, no bot needed) | H | M | VAPID + D1 subscriptions |
| 10.3 | Image pipeline: real WebP/AVIF assets, width/height attrs, lazy loading (kills CLS) | M | L | 9.5 |
| 10.4 | Prefetch on hover/focus for internal nav (instant feel) | M | L | |
| 10.5 | Public API edge caching (s-maxage + SWR) for content/brief; purge on sync | M | L | |
| 10.6 | Error tracking: CF Analytics Engine custom events (free tier) or Sentry free — ⚑ pick; never log PII/secrets | M | L | |
| 10.7 | Status page: real health of Alpaca/AI/D1/bridges/crons on /status (public booleans only) | M | M | health fns exist |
| 10.8 | Automated nightly D1 backup to R2 + documented restore drill | H | M | workflow |
| 10.9 | CSP nonce refactor: kill 'unsafe-inline' page by page (start with new pages already clean) | M | M-H | monolith debt |
| 10.10 | Split monolith pages into shared layout partials via tiny build step (eleventy or esbuild) — only if it survives the "does it reduce bytes/complexity" test | M | H | measure first |
| 10.11 | Load testing for brief generation day-start spike (queue dedupe so 10 cron hits = 1 run) | M | L | |
| 10.12 | Uptime cron alerting: workflow pings health endpoints, posts failures to private Discord channel | M | L | |

## 11. Owner operations (make PJ's life easy)

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 11.1 | **Weekly owner metrics email/Discord post**: signups, trials, renewals (Whop API?), brief open rate, top tools used — all aggregate, no PII | H | M | Whop API key ⚑ |
| 11.2 | Content calendar tab in the sheet (planned posts/topics) rendered on an internal-only page | M | L | |
| 11.3 | One-click "regenerate brief" button (admin v1) | M | L | admin routes |
| 11.4 | Sheet-side validation (dropdowns for status/result/type) to prevent sync garbage | M | L | Apps Script |
| 11.5 | Backup of the Sheets themselves (weekly export to R2) | M | L | |
| 11.6 | "Add lesson" flow that doesn't touch code: lessons from Google Docs → sheet → sync (if courses move off static JSON later) | M | M-H | v2 decision |

## 12. SEO & content engine

| # | Idea | I | E | Notes |
|---|------|---|---|-------|
| 12.1 | Editorial calendar targeting futures-intent keywords: "NQ vs ES", "MES micros explained", "best prop firm for futures", "gap fill strategy stats" | H | M | ⚑ PJ topics |
| 12.2 | Every Edge Lab preset gets an indexable findings page (server-rendered stats + methodology + date) — programmatic but substantive | H | M | 1.2 |
| 12.3 | Breadcrumb + Article + FAQ structured data (only true fields) | M | L | |
| 12.4 | Internal linking pass: lessons ↔ tools ↔ glossary ↔ presets | M | L | |
| 12.5 | RSS for brief + blog (in completion prompt already) + submit to readers | M | L | |

## 13. Anti-recommendations (do NOT build)

- ❌ Native mobile apps — PWA covers it at 1% of the cost
- ❌ Own billing/subscriptions — Whop handles tax, fraud, dunning
- ❌ Paid AI APIs — Workers AI free tier is sufficient for all planned features
- ❌ Performance-claim marketing (returns, win rates as promises) — compliance + trust suicide
- ❌ Fake urgency/viewers/scarcity — permanently banned (tests enforce)
- ❌ Heavy SPA framework migration — current stack hits the budgets
- ❌ Discord scraper bots / DM automation — ToS risk
- ❌ Signal-selling framing — education positioning only

## 14. Suggested sequence (after the completion sprint)

**Now (highest leverage):** 3.1 daily quiz · 3.2 journal · 6.9 callout tracker · 4.1 annual plan · 9.5 logo · 10.2 web push
**Next:** 6.1 gap stats · 6.2 seasonality · 5.2 chart drills · 8.1-8.2 Discord bot/OAuth · 11.1 metrics email
**Later:** 5.1 scenario sim · 7.3 vision coach · 10.9-10.10 refactor · 12.2 programmatic pages
