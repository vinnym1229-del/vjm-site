# Owner checklist — the things only you can do

Everything here is blocked on a dashboard login, a legal decision, or a fact
only you know. Nothing on this list can be done from the repository.

Ordered by consequence, not by effort. The first two are the ones costing you
something every day they stay undone.

---

## 1. The entire site is invisible to Google

`_headers` sends `X-Robots-Tag: noindex` on `/*`. That is a deliberate hold —
it was put there so the site could not be indexed under the wrong domain — but
it means **no page of this site can appear in any search result**, including
the free course, the prop-firms page and the newsletter.

**To lift it:** confirm in the Cloudflare Pages dashboard that the custom
domain matches the canonical origin declared in `robots.txt`
(`not-financial-advice-vjm.com`), then delete the single `X-Robots-Tag: noindex`
line from the `/*` block in `_headers`. Pages that must stay unindexed
(member tools, the research engine, `/unsubscribe`) carry their own rules
further down that file and are unaffected.

Do not lift it while the domain is unsettled — being indexed under the wrong
hostname is harder to undo than waiting.

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

---

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
- [ ] **Turnstile (optional).** The endpoint enforces it the moment
      `TURNSTILE_SECRET_KEY` exists. The front-end widget is **not on the form
      yet**, so setting the secret today would reject every signup. Ask me to
      add the widget first, or set the secret and immediately test a signup.
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
- [ ] **The weekly schedule is a hand edit.** It mirrors your graphic and has
      to be changed in `index.html` every time the week changes. Moving it to
      the Sheet CMS tab (`/api/content?type=schedule`) would let you update it
      from the spreadsheet — worth doing if the schedule keeps moving.

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
