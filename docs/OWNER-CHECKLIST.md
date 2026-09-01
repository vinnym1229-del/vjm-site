# Owner checklist — the things only you can do

Everything here is blocked on a dashboard login, a legal decision, or a fact
only you know. Nothing on this list can be done from the repository.

Ordered by consequence, not by effort. The first two are the ones costing you
something every day they stay undone.

---

## 1. Indexing — now automatic, nothing to do

*(Was: "the entire site is invisible to Google.")*

This is no longer a switch anyone has to flip. `_headers` still sends
`X-Robots-Tag: noindex` on everything as a **default**, and
`functions/_middleware.js` removes it per request when the request arrives on
the canonical host (`not-financial-advice-vjm.com`) and the path is not one of
the permanent exclusions. So:

- A `*.pages.dev` or preview host can never be indexed.
- The real domain becomes indexable the moment it is actually serving the site.
- Any bug in that path fails toward "not indexed", never toward "the preview
  host is in Google" — which is the far more expensive mistake.

To put the whole site back behind a hold, set the `INDEXING` environment
variable in Cloudflare Pages to anything other than `on`. Do **not** delete the
`noindex` line from `_headers`; it is what makes the default safe.

## 2. The $100 and $129 products are currently identical

Until `WHOP_PRODUCTS_FUTURES` and `WHOP_PRODUCTS_COMPLETE` are set in
Cloudflare Pages, every verified member resolves to Complete. A Futures Core
buyer gets the full library, which is the difference between the two prices.

**To fix:** Cloudflare Pages → Settings → Variables → set both, in
**Production and Preview**, to the Whop product/plan ids for each tier
(comma-separated).

Check the ids before you paste them — a typo does not error, it silently sends
that product down the wrong branch:

```bash
node tools/entitlement-check.mjs --futures="prod_…" --complete="prod_…"
```

Also decide `STRICT_LEGACY_SESSIONS`: leaving it unset grandfathers sessions
issued before tiers existed (they expire on their own within 7 days); setting
it to `true` forces everyone to sign in again once. See `docs/ENTITLEMENTS.md`.

### Related: the Whop webhook has never fired

The live database has **zero** rows in `webhook_events` and **zero** in
`whop_codes`, and the only audit events are seven `verify_code` entries from
28–29 August. Nothing from Whop has ever reached this site. So the membership
pipeline — purchase → webhook → access — is not merely unconfigured, it is
unproven end to end. Worth one test purchase (or a Whop test event) before
relying on it, separately from setting the two variables above.

The same query shows `site_content` is empty: the Google Sheet CMS has never
synced, so the prop-firm directory renders its "not connected yet" state on the
live site and every CMS-driven section falls back to what is hard-coded.

## 3. Things that are legally blocking, if you are selling

- [ ] **`terms.html` has no legal entity.** The seller's exact legal name,
      jurisdiction and registered business address are marked
      `TODO: owner to confirm`. That needs filling before taking money.
- [ ] **Auto-renewal terms.** Whether any plan has a trial, the price after
      it, and the cancellation route, all need stating. US state auto-renewal
      laws and UK/EU distance-selling rules differ — a lawyer should say which
      apply to you, not this file.
- [ ] **Per-firm affiliate disclosure.** `prop-firms.html` currently carries a
      deliberately vague disclosure ("may be paid a commission") because the
      real arrangement per firm is not known here. For each firm, say which it
      is: commission, revenue share, flat fee, free evaluation, paid
      placement, or nothing at all. If a firm pays nothing, say so for that
      firm — the generic wording understates some and overstates others.
- [ ] **Substantiate the social-proof numbers** (5.0, 2,240 reviews, 49,136
      joined). These are Whop platform figures snapshotted 2026-08-24. Keep a
      dated Whop listing export. If any number is ever restated as a *result*
      rather than a platform stat, it needs broker/prop-firm records with
      dates, deposits, withdrawals, every losing period in the range, and the
      calculation method.
- [ ] **Retention periods.** `privacy.html` has three open TODOs: how long
      `analytics_events`, `newsletter_subscribers` (subscribed and suppressed)
      and the Whop membership/audit records are kept. Publish a period only
      once something actually enforces it — a stated period nobody enforces is
      worse than none.

## 4. Checkout links

`index.html` and `assets/curriculum.js` point every plan button at the generic
Whop listing, marked `TODO: owner to confirm`. Per-plan checkout URLs would
drop people straight onto the right plan instead of a page where they can pick
the wrong one. Get the two URLs from Whop and they can be swapped in.

## 5. The newsletter, to make it actually send

Signups are live and stored. Nothing reaches an inbox until you pick a
provider. `docs/NEWSLETTER.md` has the export command, the unsubscribe link
format, and the `List-Unsubscribe` headers to set.

- [ ] Choose an email provider and add its credential.
- [ ] **Turnstile (optional).** The widget is now on the signup forms and
      configures itself, so this is purely an environment change — but set
      **both** variables or nothing works:
      `TURNSTILE_SITE_KEY` (public; the page fetches it) and
      `TURNSTILE_SECRET_KEY` (private; verifies the token).
      Setting only the secret makes the server reject every signup; the form
      detects exactly that case and says so on load rather than letting people
      fail one at a time. Setting only the site key renders a widget that is
      never checked. Unsubscribing is never gated by it.
- [ ] Read the list any time:
      `npx wrangler d1 execute vjm-content --remote --command "SELECT status, COUNT(*) FROM newsletter_subscribers GROUP BY status"`

## 6. Content only you have

- [ ] **The Notion playbook URL.** `prop-firms.html` has an empty
      `data-playbook-url` on `<section id="playbook">`; the section stays
      hidden until it is set, so no dead link ships. Paste the shared Notion
      page URL in, or send it to me.
- [ ] **A team bio** is still marked `TODO: owner to supply full bio`.
- [ ] **Session durations.** The countdown assumes 90 minutes for trading
      sessions and 60 for classes. If those are wrong the "live now" state is
      wrong.
- [ ] **Turn on the sheet sync — this is the big one.** The schedule, the
      prop-firm directory, the team, the FAQs, the bundles and the stats are
      all already wired to read from a Google Sheet. The Apps Script bridge is
      written (`apps-script/content-sync/Code.gs`), the endpoint is written
      (`/api/content-sync`), and the hourly GitHub Action now exists. It has
      simply never been switched on, which is why `site_content` is empty and
      the prop-firm page shows "not connected yet" to real visitors.

      Once it runs, **you edit a spreadsheet and the site updates itself within
      the hour** — no deploy, no code edit, nobody in the loop. That is the
      answer to "who updates the schedule every week".

      Four steps:
      1. Apps Script: deploy `apps-script/content-sync/Code.gs` from your
         content spreadsheet (Script Properties: `SHEET_ID`,
         `CONTENT_BRIDGE_SECRET`). See `docs/APPS-SCRIPT-INTEGRATION.md`.
      2. Cloudflare Pages → Variables: `CONTENT_BRIDGE_URL` (the /exec URL),
         `CONTENT_BRIDGE_SECRET` (same value), `RESEARCH_CRON_SECRET`.
      3. GitHub → repo Settings → Secrets → Actions: `RESEARCH_REFRESH_URL`
         (the site origin) and `RESEARCH_CRON_SECRET` (same value as above).
      4. Actions → "Sync site content from the owner's sheet" → Run workflow,
         and check the log prints row counts rather than an error.

      **Schedule tab columns:** `id | day | session | time_et | host | note |
      active`. `day` is Mon–Fri, `session` is one of `NYAM`, `NYPM`, `CLASS`,
      `ASIA` (uppercase), `time_et` is free text like `9:30 AM ET`.
      **Leave `host` blank to mark a slot as off** — it renders struck through,
      the way Monday 2:30 does now, instead of vanishing and leaving a gap.
      `active` = `false` removes the row entirely.

## 7. Repository and access

- [ ] The GitHub default branch is currently a feature branch
      (`claude/nlm-fvg-ifvg-bpr-2l0bhm`), not `pj`. Cloudflare deploys from
      `pj` so the site is fine, but anyone landing on the repo sees stale
      code. Settings → General → Default branch.
- [ ] Decide whether this repository should be private. It contains no
      secrets — every credential is a Cloudflare environment variable — but it
      does contain the full course content that sits behind the paywall.

---

## Verifying after a deploy

- Sign in: DevTools → Application → Cookies shows only an HttpOnly
  `__Host-vjm_session`, and nothing in localStorage.
- A Futures-tier session can open `/futures-dissection` and is refused
  `/options-lab` (this only becomes a real test after item 2).
- Newsletter: sign up with an address you control, then check the row landed:
  `npx wrangler d1 execute vjm-content --remote --command "SELECT email, status FROM newsletter_subscribers ORDER BY id DESC LIMIT 5"`
- Unsubscribe: visit `/unsubscribe`, submit that address, confirm the row
  flips to `unsubscribed` rather than disappearing.
- Schedule: the session clock names the next session and the day is right in
  your timezone.
