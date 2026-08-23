# OWNER CHECKLIST — actions only you can do

## Security (do these first)

- [ ] Cloudflare Pages → Settings → Variables: set `SESSION_SIGNING_SECRET`
      (long random ≥32 chars). Sign-in fails closed until this exists.
- [ ] Rotate every place the old admin password was reused (it shipped to
      browsers and is permanently compromised).
- [ ] If any member codes were ever screenshotted/shared, reissue them in your
      Member Tracker sheet.
- [ ] Deploy new Apps Script bridge per docs/APPS-SCRIPT-INTEGRATION.md,
      verify a test sign-in, then DELETE `MEMBERS_STATUS_URL` from Cloudflare.
      (Until then the old bridge still exposes the full sheet upstream.)
- [ ] GitHub repo Settings → change default branch from the Pine Script branch
      to `main`; point Cloudflare Pages production at `main`.

## Domain

- [ ] Confirm canonical domain: CNAME says `notfinancialadvicevjm.com`;
      INSTALL-FIRST used the hyphenated variant. Pick one, update
      `RESEARCH_REFRESH_URL`, and add redirects for the other.

## Legal / claims review before production promotion

- [ ] Performance claims ("$50K account", win cards): confirm you have
      evidence for each and acceptable wording; as-of dates recommended.
- [ ] "300+ members" / "#1-rated on Whop": supply proof link or soften.
      Recommended role statement pending approval:
      "Vinny serves as the second options trader for a 30,000+ member Discord
      community recognized as the #1-rated community on Whop."
- [ ] Have a professional review Terms/Privacy/Refund copy (integrations
      changed: cookies now HttpOnly session, Discord OAuth planned).

## Integrations (when ready)

- [ ] Alpaca keys present? Test `/api/research-engine?module=health`.
- [ ] D1 bindings `RESEARCH_DB` + `RATELIMIT_DB` created and migrations run.
- [ ] Discord/Whop: see docs/DISCORD-INTEGRATION.md — nothing is sent until
      you explicitly configure + approve dry-run outputs.

## Verification after deploy

- [ ] Sign-in works; DevTools shows ONLY an HttpOnly `vjm_session` cookie
      (nothing in localStorage).
- [ ] Calendar page shows real events or an explicit "unavailable" state.
- [ ] Stock Lab premium unlock shows the rebuilt screener (no blank iframe).
