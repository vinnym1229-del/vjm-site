# Apps Script Integration (member bridge)

## Why it changed

The previous web app returned the ENTIRE `statuses` and `codes` maps to anyone
who knew the deployment URL. Cloudflare Functions kept that URL server-side,
but the sheet itself was exposed upstream. The new bridge returns **one record**
per authenticated request and nothing else.

## Files

- `apps-script/member-sync/Code.gs` — the web app (POST-only)
- Protocol: `timestamp\nnonce\npayload` HMAC-SHA256 hex MAC keyed by `BRIDGE_SECRET`, 5-minute replay window, nonce cache dedupe, 4 KB body cap.

## Owner setup steps

1. Open your Member Tracker spreadsheet → Extensions → Apps Script.
2. Replace all code with `apps-script/member-sync/Code.gs`; save.
3. Project Settings → Script Properties:
   - `SHEET_ID` = spreadsheet ID
   - `BRIDGE_SECRET` = long random string (`openssl rand -base64 48`)
4. Deploy → New deployment → type **Web app** → Execute as **Me**,
   access **Anyone** → Deploy → copy the `/exec` URL.
5. Cloudflare Pages → Settings → Variables and Secrets:
   - add `MEMBERS_BRIDGE_URL` = the /exec URL
   - add `MEMBERS_BRIDGE_SECRET` = same value as BRIDGE_SECRET
6. Verify: attempt sign-in with a test code; check Executions log shows one invocation.
7. After verification, DELETE `MEMBERS_STATUS_URL` from Cloudflare env vars.
   This is the moment the full-map exposure actually ends.

## Sheet contract ("Members" tab)

| Discord | Code | Status |
|---|---|---|
| trader-handle | ABCD-1234 | Active |

`Status ∈ {Active, Renewed}` grants access; anything else = inactive. Column
names are matched case-insensitively; extra columns are ignored.

## Rotation & incident response

Rotate `BRIDGE_SECRET` in both places simultaneously. Requests fail closed
(not open) during the gap. Nonce cache prevents replay even if a request is
captured within the window.

## Quotas

Apps Script URL-fetch quotas don't apply here (inbound triggers); LockService
is not needed because lookups are read-only. If you later add write endpoints
(e.g., status updates), wrap mutations in LockService and re-run quota tests.
