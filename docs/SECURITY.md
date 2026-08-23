# Security Model & Remediation Status

Threat model in one line: anonymous visitors, premium members with codes, and the owner interact with a static site + serverless Functions; all authority must live server-side; market data must never be fabricated.

## Controls implemented on this branch

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| S1 | Browser-side admin password removed (`VINNY_ADMIN_01`); client-gated admin/blog/P&L mutation UI deleted | **Done** | index.html diff; test `removed secret stays removed` |
| S2 | Dedicated `SESSION_SIGNING_SECRET`; access codes never used as HMAC key material; fail-closed when unset | **Done** | `functions/api/_lib/session.js` `resolveSigningSecret()`; tests |
| S3 | Sessions move from localStorage to `HttpOnly; Secure; SameSite=Lax` cookies; tokens never in URLs or response bodies | **Done** | verify-premium.js, all pages migrated; tests assert no token keys/URL tokens |
| S4 | Legacy `?token=` verification path removed | **Done** | site-structure test asserts absence |
| S5 | Generic auth errors (no code/status enumeration) on verify + member lookup | **Done** | `GENERIC_BAD_CODE`, unified 404 path in check-member-status |
| S6 | Rate limiting per IP+identifier (verify 10/min, member-status 8/min, quotes 30/min) via D1 when bound, best-effort in-memory otherwise | **Done** (D1 recommended) | `_lib/http.js checkRateLimit`, migration 0002 |
| S7 | Audit events (verify grant/reject, logout) written with hashed subjects only | **Done** (best-effort) | verify-premium.js `auditEvent` |
| S8 | Security headers: CSP (no wildcards), HSTS, nosniff, frame-ancestors, Referrer-Policy, Permissions-Policy, COOP | **Done** for static assets | `_headers` |
| S9 | Apps Script bridge redesigned as authenticated single-record lookup with HMAC+nonce+replay window | **Code shipped** (`apps-script/member-sync/`), deployment is an owner action | docs/APPS-SCRIPT-INTEGRATION.md |
| S10 | Fabricated data removed: simulated viewers, launch-spots scarcity bar | **Done** | tests assert markers stay out |
| S11 | Client-side member list (`activeMembersFallback`) removed — honest failure states instead | **Done** | index.html checkStatus rewrite |
| S12 | `.env.example` with placeholder-only names | **Done** | test enforces no real-looking values |

## Known debt / staged work

- **CSP `'unsafe-inline'` for scripts/styles**: current pages ship large inline `<script>`/`<style>`. Removing these across a 2.7 MB monolith is a structural project (Phase 2 modularization). No wildcard sources are used; TradingView origins are pinned.
- **Legacy full-map bridge**: until the owner deploys the new Apps Script and switches env vars, `MEMBERS_STATUS_URL` remains supported server-side only. Browsers can never reach it directly, but the upstream URL itself still dumps the map to anyone who knows it → **deploy the new bridge promptly**.
- **Session revocation list**: cookies are stateless signed tokens (7d). Revocation-on-demand requires a D1 denylist checked in `getSession()` — designed, not yet wired (see ARCHITECTURE).
- **Turnstile**: rate limits are in; Cloudflare Turnstile on repeated failures should be added once the owner creates a site key.
- **Rotation checklist (owner)**:
  1. Set a fresh `SESSION_SIGNING_SECRET` (never reused elsewhere).
  2. Rotate any credential ever equal to `VINNY_ADMIN_01`.
  3. Issue new member codes if any may have been shared/screenshotted (the old code list also signed sessions historically).
  4. Deploy new Apps Script bridge; then delete `MEMBERS_STATUS_URL` from Cloudflare env.

## Threat notes

- Enumeration: unknown code vs inactive code return identical bodies/status.
- Timing: signature comparisons are constant-time; length-mismatch path burns comparable cycles.
- SSRF: outbound calls use fixed allowlisted hosts (Alpaca, faireconomy feed, Yahoo RSS host, owner-configured bridge URL). Symbols validated by regex before any URL construction.
- Caching: all API responses `Cache-Control: no-store`; personalized pages revalidate.
