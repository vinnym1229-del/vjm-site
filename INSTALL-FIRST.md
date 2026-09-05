# Install the VJM Research Engine

This ZIP contains the complete website package. The research dashboard is `research-engine.html`; its secure server endpoint is `functions/api/research-engine.js`.

## 1. Publish the files

Upload the package to the repository connected to your existing Cloudflare Pages project, preserving every folder path. If you use the prepared GitHub pull request, review and merge that branch instead of uploading the ZIP manually.

## 2. Add Cloudflare secrets

In **Cloudflare Dashboard â†’ Workers & Pages â†’ your Pages project â†’ Settings â†’ Variables and Secrets**, add these as encrypted secrets for Production and Preview:

- `SESSION_SIGNING_SECRET` (REQUIRED — dedicated session key, ≥32 random chars)
- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `PREMIUM_ACCESS_CODES` (legacy codes; no longer used as a signing key)
- `MEMBERS_BRIDGE_URL` + `MEMBERS_BRIDGE_SECRET` (preferred authenticated bridge — see docs/APPS-SCRIPT-INTEGRATION.md)
- `MEMBERS_STATUS_URL` (legacy bridge only; delete after migration)
- `RESEARCH_CRON_SECRET` (recommended)

Do not put secret values in any HTML or JavaScript file. Placeholder names live in `.env.example`.

## 3. Add persistent history (recommended)

Create a Cloudflare D1 database, bind it as `RESEARCH_DB` (and `RATELIMIT_DB`
for rate limits + audit events), and apply:

```bash
npx wrangler d1 execute vjm-research --remote --file=migrations/0001_research_engine.sql
npx wrangler d1 execute vjm-research --remote --file=migrations/0002_security_tables.sql
```

Without D1, the dashboard still works, but historical snapshots and last-good-result fallback are disabled.

## 4. Configure automatic refresh (recommended)

In GitHub repository secrets, add:

- `RESEARCH_REFRESH_URL` = `https://not-financial-advice-vjm.com`
- `RESEARCH_CRON_SECRET` = the same value configured in Cloudflare

The included workflow at `.github/workflows/research-refresh.yml` then refreshes the saved research data automatically.

## 5. Verify

1. Open `/api/research-engine?module=health` and confirm `configured.alpaca` and `configured.premiumSecret` are `true`.
2. Sign in through the site's premium gate.
3. Open `/research-engine.html` and select **Options / Price Action**.
4. Choose QQQ or SPY, select a 5-, 20-, or 40-trade-day sample, and click **Run full scan**.
5. Confirm the dashboard shows SIP and BOATS bar counts, an as-of time, sample sizes, and no fabricated values.

The overnight/Asia/London studies are explicitly QQQ/SPY ETF proxies. They are designed to test similar price action; they are not actual CME NQ/ES volume or order flow.

Full data definitions and troubleshooting are in `docs/research-engine-setup.md`.
