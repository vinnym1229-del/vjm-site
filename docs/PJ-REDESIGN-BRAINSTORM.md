# PJ Site Redesign — Master Brainstorm (futures-first)

Owner directive 2026-08-24: PJ portion of the site becomes FUTURES-FIRST.
Stocks and options are the side piece. Bundles, FAQ, team, schedule, socials,
and video all updated to match the owner's live Whop listing. Everything must
be owner-updatable without an AI editing code.

Source of truth used: owner's uploaded Whop screenshots + stream schedule
graphic (2026-08-24). Every number below is owner-supplied, not invented.

---

## 0. Ground truth — data corrections required (current site is stale)

| Claim on site today | Whop reality (owner screenshots) | Action |
|---|---|---|
| $129/mo (hero, premium box, services, discord CTA) | **$100/mo**, +2 options: **$529/6mo (12% off)**, **$1,000/yr (18% off)** | Replace everywhere; show 3 bundle tiers |
| "30,000+ members" | Product page: **2.8K members**; Whop profile: **49,136 joined** | Owner picks which number; wire as CMS-editable stat |
| "ten years of hands on experience" (hero + about) | Whop bio: "**9-year pro**" | Owner confirms 9 vs 10; make CMS-editable |
| Rated 5.0 on Whop | 5.0 (**2,240 reviews**) | Keep, add review count |
| Schedule: 9:15 AM–2 PM ET daily, pre-market brief 9:00 | NYAM **9:30 AM**, NYPM **2:30 PM**, ASIA **8:00 PM**, night class **5:30 PM** (Tu/Th), live **3–5x/week** | Rebuild schedule section + countdown logic |
| Feature list: futures/options/stock courses + streams + callouts | Carousel: **Live Futures Trading & Analysis**, **Exclusive Education & Market Insights**, **Live Group Classes 2x/month**, **1HR+ Starter Crash Course (IFVG Model)**, **Exclusive Prop Firm Giveaways (win up to $50,000 funding)** | Rewrite feature list futures-first |
| No FAQ | 3 FAQs (verbatim from Whop): live trading 3–5x/week; entries/exits shared via Discord live trading; **no refunds, cancel anytime** | New FAQ section |
| No team section | Schedule shows hosts: **PJTrades, Caleb, Fin, Gainz, KWT** | Meet the Team section (bios = TODO owner) |
| No video | Owner has 232 MB intro video | See §2 hosting decision |
| No social links | YouTube @PJTrades_NQ, X @PJtrades_NQ, TikTok @pjtrades, Instagram @pjtradesnq | Nav + footer + hero strip |
| Checkout link whop.com/pjtradespremium/ | Same — keep | ✓ |

## 1. Futures-first restructure

1. Hero headline → futures-forward (e.g., "Trade Futures With a Pro." /
   "Master NQ & ES. Markets, Made Simple." — final copy owner-approved).
   Handle brand is PJTrades_NQ → NQ is the identity.
2. Section order proposal: Hero → proof bar → **What You Get (futures-first
   feature grid from Whop carousel)** → **VIDEO** → **Bundles** → FAQ →
   **Stream Schedule** → **Meet the Team** → **Testimonials/Payout wall** →
   Prop Firms → Insights (futures items first) → Discord CTA.
3. Demote Options Lab + Stock Lab in nav to a "More tools" cluster; add
   Futures-first nav items (Pre-Market, Research Engine stay prominent).
4. Ticker tape: replace crypto-heavy tape with NQ/ES/MNQ/MES + VIX + DXY +
   key names (TradingView symbols: CME_MINI:NQ1!, ES1!, etc.).
5. premarket.html copy: lead with NQ/ES lean, futures session map (Globex
   sessions: ASIA/London/NYAM/NYPM).
6. Insights: add futures education posts (MNQ vs NQ sizing, tick math,
   session behavior, news days) — owner supplies via CMS or Discord imports.
7. Essay (Discipline) stays — it's market-agnostic — but moves below fold.

## 2. Video above bundles — 232 MB reality check

Cloudflare Pages hard limit: 25 MiB per static file; git repo shouldn't carry
232 MB (OneDrive + deploy bloat). Options, recommended order:

- **A (recommended): YouTube unlisted** → embed iframe. Free, fast, owner
  uploads from phone. CMS field holds the URL. Con: YouTube chrome/logo.
- **B: Compress to <20 MB (720p)** and self-host at assets/pj-intro.mp4.
  I can do this with ffmpeg if owner accepts quality tradeoff. Short-term OK.
- **C: Cloudflare Stream** (~$5/mo class) → adaptive streaming, no YouTube
  branding, embeddable. Best quality-to-control; small cost.
- Either way: build the slot now with **poster image + lazy iframe/video**,
  `preload="none"`, reduced-motion safe, so the source can swap via CMS.

## 3. Bundles & pricing section (per Whop)

1. Three-tier display: Monthly $100 · 6-Month $529 (save 12%) · Annual
   $1,000 (save 18%). "Best value" badge on annual (owner confirms which to
   highlight).
2. All CTAs → https://whop.com/pjtradespremium (plan selection happens on
   Whop, matching the "Choose your plan" modal screenshot).
3. Feature checklist under the bundle (futures-first): live futures trading
   & analysis 3–5x/week · daily callouts & entries/exits via Discord ·
   exclusive education & market insights · group classes 2x/month · 1HR+
   Starter Crash Course + IFVG model · prop firm giveaways (up to $50K
   funding) · community.
4. Trust row: 5.0 ★ (2,240 reviews) · 2.8K members (or owner-picked number).
5. No-refund policy must appear near CTA (transparency + Whop parity):
   "There are no refunds. You can cancel your membership at anytime."

## 4. FAQ section (verbatim from owner's Whop)

- Do you offer live trading? → "Yes! I go live 3 to 5 times a week, depending
  on the economic calendar and market conditions."
- Do you share entries and exits? → "Yes, all entries and exits are shared
  via discord live trading."
- What is your refund policy? → "There are no refunds. You can cancel your
  membership at anytime."
- Add FAQPage JSON-LD schema for Google rich results.
- CMS-editable so owner can add Q&As without code.

## 5. Meet the Team

- Roster visible from schedule: PJTrades, Caleb, Fin, Gainz, KWT.
- Bios/roles/photos: TODO owner supplies (never invent). Placeholder cards
  with name + "Bio coming soon" until then.
- Structure: name, role (e.g., "Futures — NYAM", "Order Flow", "Night
  Classes"), photo, optional socials.
- CMS tab `team` so owner adds people/images anytime.

## 6. Stream Schedule system

- Replace static table with CMS-driven weekly grid matching the owner's
  graphic: Day × Session (NYAM/NYPM/CLASS/ASIA) × time × host × note.
- Countdown bar rewrite: next session computed from CMS schedule (NYAM
  9:30, NYPM 14:30, CLASS 17:30, ASIA 20:00 ET) instead of hardcoded
  9:15–14:00. "LIVE NOW" window per session block.
- Host names color-coded like the graphic (PJTrades gold, Caleb blue, etc.).
- Optional: owner flips a "live now" cell in the sheet → site + Discord
  announcement auto-fire (existing webhook pipeline).

## 7. Social links

YouTube @PJTrades_NQ · X @PJtrades_NQ · TikTok @pjtrades · Instagram
@pjtradesnq. Placement: nav icons, footer, hero trust strip, team cards,
"Follow" section with embeddable TikTok/IG walls (phase 2+).

## 8. Premium Starter Course (futures)

- Dedicated CTA block: "Start with the Futures Starter Crash Course" →
  TODO owner supplies the Whop product URL (standalone product vs included
  in premium).
- Funnel idea: free/cheap starter → premium upsell path; landing section
  with crash-course syllabus (chart setup, IFVG model) from owner.

## 9. Owner self-service CMS expansion (the backbone ask)

Extend the existing Sheets → /api/content pipeline (announcements,
trade_reviews, prop_firms already work) with new tabs:

| Tab | Fields | Renders into |
|-----|--------|--------------|
| schedule | day, session, timeET, host, note, active | Schedule section + countdown |
| team | name, role, bio, photoUrl, socials, order | Meet the Team |
| bundles | name, price, period, saveBadge, features, whopUrl, highlight | Bundles |
| faqs | question, answer, order | FAQ |
| media | key (heroVideo/poster), url | Video + carousel |
| testimonials | imageUrl, caption, source, order | Payout wall |
| stats | key (members/reviews/years), value, label | Hero + proof bar numbers |

Requires content-sync.js + integrations-core.js type expansion (backend —
owner-gated per AGENTS.md; single PR, then owner just edits the sheet).
Result: owner changes prices, schedule, team, FAQs, video, stats from their
phone via the Sheets app. No AI, no code, hourly auto-sync + manual dispatch.

## 10. Testimonials / Payout wall

- Owner's screenshots (Apex $150K passes, Topstep payouts, NQ funded
  certs, "50k passed") → horizontal slider like Whop's carousel.
- Images uploaded by owner via CMS (or a Drive folder the Apps Script reads).
- Mandatory caption: "Results not typical; examples, not guarantees" +
  link to risk-disclosure. Never fabricate; only owner-supplied images.
- Review summary block: 5.0 ★ · 2,240 ratings · 97% 5-star (from screenshot).

## 11. Copy sweep checklist (exact locations on branch pj)

- [ ] index.html hero CTA $129 → $100 + bundles anchor
- [ ] Hero badge "30,000+ members" → owner-picked stat (CMS)
- [ ] Hero + about "ten years" → 9 (pending owner confirm)
- [ ] Premium Hub box: price, features, "One bundle" copy
- [ ] Dashboard tab "$50/mo Launch rate" card → remove/CMS
- [ ] Services cards: $129 → $100; Portfolio Review + Bootcamp — owner
      confirms still offered, else cut section
- [ ] Schedule table + countdown logic (see §6)
- [ ] Discord CTA "Go Premium — $129/mo" → $100
- [ ] About stat cards "10 / 30K+"
- [ ] Meta description/OG: futures-first wording
- [ ] premarket.html: futures session framing
- [ ] Brand: "PJ TRADES × St" → pure "PJ TRADES"? (owner decision)

## 12. Futures-trader tool ideas (hedge-fund flavor)

1. NQ/ES/MNQ/MES tick & P&L calculator (contract math, $2/pt MNQ etc.).
2. Session heatmap: ASIA/London/NYAM/NYPM behavior explainer with live
   session highlight.
3. Economic-calendar-first pre-market page (already exists — surface
   high-impact red events above the fold, futures-specific notes).
4. "Futures lean" badge from market-brief shown on homepage daily
   (auto-generated, low-confidence label, existing pipeline).
5. Overnight Globex open/close countdowns per session.
6. Trade-review-of-the-day pulled from CMS on homepage.
7. Glossary page: IFVG, FVG, BPR, sweeps, displacement — owner-approved
   definitions (ties to Starter Course).
8. Prop-firm giveaway banner: "Win up to $50,000 in funding — members only"
   → Whop CTA (compliance: "chance to win", no guarantees).

## 13. SEO / performance / analytics

1. FAQPage + Person/Organization JSON-LD; sitemap.xml with pj pages;
   robots.txt.
2. OG/Twitter cards with PJ-branded image (owner supplies 1200×630).
3. Video: poster + facade player (click to load iframe) — protects LCP;
   Lighthouse budget check after each phase (baseline 69 local).
4. Cloudflare Web Analytics (free, no cookies) for owner dashboards.
5. Canonical audit: futures-first pages canonical to production URLs.
6. Accessibility: carousel controls keyboard-operable, reduced-motion for
   slider/autoplay video.

## 14. Compliance & trust

1. No-refund policy visible pre-purchase (near CTAs + FAQ + terms link).
2. Testimonials/payouts disclaimer everywhere results appear.
3. Giveaway wording: "chance to win", sponsor names only as owner states.
4. Keep "educational only — not financial advice" in footer/disclosure.
5. Entries/exits shared "via discord live trading" — add educational,
   not-signals-service framing line (owner approves wording).

## 15. Open questions for owner (block exact copy, not layout work)

1. Experience: 9 years (Whop) or 10 (current site)?
2. Which member number is public: 2.8K premium, 49,136 joined, or other?
3. Drop "× St" co-brand on the PJ site entirely?
4. Are Portfolio Review ($100) and 1-on-1 Bootcamp ($100/hr) still sold?
5. Starter Crash Course: separate Whop product URL?
6. Video hosting: YouTube unlisted (recommended), compressed self-host, or
   Cloudflare Stream?
7. Team: confirm roster (PJTrades, Caleb, Fin, Gainz, KWT) + roles/bios/
   photos when ready.
8. Which payout screenshots may be featured on the wall?

## 16. Suggested build order

- Phase 1 — Truth sweep (no backend): pricing/bundles, FAQ, stats, socials,
  nav re-order, ticker swap, meta copy. Site is instantly accurate.
- Phase 2 — Video slot + team + schedule sections (static content, owner
  fills placeholders).
- Phase 3 — CMS expansion (backend PR, owner-gated): new tabs → sections
  become owner-editable end to end.
- Phase 4 — Testimonial wall, starter-course funnel, JSON-LD, analytics.
- Phase 5 — Futures tools (tick calc, session heatmap, lean badge).
