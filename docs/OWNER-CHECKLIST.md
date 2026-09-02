# Owner checklist — the things only you can do

Everything here is blocked on a dashboard login, a legal decision, or a fact
only you know. Nothing on this list can be done from the repository.

Ordered by consequence, not by effort. The first two are the ones costing you
something every day they stay undone.

---

## 0. ~~Change the GitHub default branch to `pj`~~ — done

Default branch is `pj`. All four GitHub Actions workflows are registered and
running (content sync confirmed live 2026-09-02 — see item 6).

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
- [x] **Turn on the sheet sync — done and confirmed live (2026-09-02).** The
      schedule, the prop-firm directory, the team, the FAQs, the bundles and
      the stats all read from the Google Sheet ("PJ Trades — Site Content"),
      via the Apps Script bridge (`apps-script/content-sync/Code.gs`) and the
      hourly GitHub Action. A live run against the real domain upserted all
      16 Schedule rows with no errors — `{"schedule":{"received":16,
      "upserted":16,"skipped":0}}`. Two real bugs stood between "written" and
      "working" and both are now fixed: the Apps Script project's
      `CONTENT_BRIDGE_SECRET` had to be regenerated (`setUp()` re-run) and
      re-pasted into Cloudflare, and a stray leftover Worker (`vjm-site`,
      predating the Pages migration, unrelated code) was deleted from the
      Cloudflare account.

      **You edit a spreadsheet and the site updates itself within the hour**
      — no deploy, no code edit, nobody in the loop. That is the answer to
      "who updates the schedule every week". Every tab except Schedule is
      still empty (0 rows) — that's expected, not broken; fill in
      announcements, team, FAQs, bundles, prop firms, stats, or results
      whenever you're ready and they'll appear on the next hourly sync.

      Reference — how this was set up, kept here for adding a new tab later
      or if the secret ever needs rotating:
      1. **The spreadsheet already exists** — "PJ Trades — Site Content" is in
         your Drive, with the Schedule tab filled in with this week:
         https://docs.google.com/spreadsheets/d/1kqp-qoEU5v9ygV8PpgpVnOvxtyGNsFbgR86t9zDNuUY/edit

         It is deliberately a SEPARATE file from `VJM_Member_Tracker`, which
         holds member names, payments and plaintext access codes. Website
         content and member credentials must not share a spreadsheet.

         Open it → Extensions → Apps Script, paste in
         `apps-script/content-sync/Code.gs`, then pick **`setUp`** in the
         function dropdown and press Run. (The single tab is currently named
         after the file because it was imported from CSV; `setUp` recognises
         its columns and renames it to `Schedule` for you.)

         It builds all nine tabs with the right headers, seeds the Schedule
         tab with the exact week the site shows right now (so switching the
         sync on changes nothing visible), generates the shared secret, and
         prints what to paste where. Re-running it is safe — it never
         overwrites a tab, a row, or an existing secret.

         Then Deploy → New deployment → Web app, Execute as **Me**, access
         **Anyone**, and copy the `/exec` URL. Opening that URL in a browser
         should show `{"ok":true,"service":"content-bridge"…}` — that is how
         you confirm you copied the right one.

         `healthCheck` in the same dropdown reports how many usable rows each
         tab has, which is the fastest way to spot the common mistake of rows
         with a blank `id` column (the bridge drops those silently).
      2. Cloudflare Pages → Variables: `CONTENT_BRIDGE_URL` (the /exec URL),
         `CONTENT_BRIDGE_SECRET` (same value), `RESEARCH_CRON_SECRET`.
      3. GitHub → repo Settings → Secrets → Actions: `RESEARCH_REFRESH_URL`
         (the site origin) and `RESEARCH_CRON_SECRET` (same value as above).
      4. GitHub → Actions → "Sync site content from the owner's sheet" →
         Run workflow, and check the log prints row counts rather than an
         error.

      **Schedule tab columns:** `id | day | session | time_et | host | note |
      active`. `day` is Mon–Fri, `session` is one of `NYAM`, `NYPM`, `CLASS`,
      `ASIA` (uppercase), `time_et` is free text like `9:30 AM ET`.
      **Leave `host` blank to mark a slot as off** — it renders struck through,
      the way Monday 2:30 does now, instead of vanishing and leaving a gap.
      `active` = `false` removes the row entirely.

## 7. Repository and access

- [ ] **The default branch is wrong, and it is silently disabling every
      scheduled job.** See item 0 — this is not cosmetic.
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
