# Deployment & Rollback

## Environments

Cloudflare Pages project (existing). Production branch: **confirm in dashboard**
(the GitHub default branch is currently a Pine Script branch — see MASTER-AUDIT
F-BR1; recommended: make `main` the Pages production branch and merge this work
via PR).

## Required Cloudflare secrets (Production AND Preview)

| Variable | Purpose |
|---|---|
| `SESSION_SIGNING_SECRET` | session HMAC key (≥32 chars) — REQUIRED or sign-in fails closed |
| `PREMIUM_ACCESS_CODES` | legacy member codes (bridge still validates against sheet) |
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | quotes + research |
| `MEMBERS_BRIDGE_URL` + `MEMBERS_BRIDGE_SECRET` | new Apps Script bridge (preferred) |
| `MEMBERS_STATUS_URL` | legacy bridge — DELETE after new bridge verified |
| `SESSION_DAYS` | optional, default 7, max 30 |
| `RESEARCH_CRON_SECRET` | scheduled refresh auth |
| D1 bindings: `RESEARCH_DB`, `RATELIMIT_DB` | snapshots, rate limits, audit |

Apply migrations:
```bash
npx wrangler d1 execute <DB> --remote --file=migrations/0001_research_engine.sql
npx wrangler d1 execute <DB> --remote --file=migrations/0002_security_tables.sql
```

## GitHub Actions secrets

- `RESEARCH_REFRESH_URL` = canonical site URL (**fix**: use the domain actually served by Cloudflare)
- `RESEARCH_CRON_SECRET` = same value as Cloudflare's

## Deploy checklist

1. Tests pass locally (`npm test`) and in CI.
2. Migrations applied to BOTH preview and production D1.
3. Secrets present for both environments.
4. Preview deployment smoke-tested:
   - sign-in sets cookie, no token in body/URL (check DevTools → Application → Cookies)
   - `/api/research-engine?module=health` shows configured flags true
   - calendar page renders real events or explicit unavailable state
5. Owner approves legal/perf copy (see OWNER-CHECKLIST).
6. Promote to production.

## Rollback

- Pages: Deployments → previous deployment → **Rollback** (instant, no DB change).
- D1 migrations are additive (CREATE TABLE IF NOT EXISTS) — old code runs fine with new tables; rollback needs no down-migration.
- Session secret rotation invalidates all sessions by design. If a bad secret
  ships, set the previous value back to restore sessions.
- Legacy token compatibility window: if members are locked out after deploy,
  set `LEGACY_ALLOW_CODES_AS_KEY=true` temporarily so pre-migration tokens
  verify while cookies propagate.

## Never do

- Never reintroduce a root `wrangler.toml` with Pages config that breaks Functions builds (prior incident noted in repo history discussion; Pages reads dashboard settings).
- Never echo secret values in workflow logs.
