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

---

# Content Bridge (owner-editable website content)

A second, separate bridge: `apps-script/content-sync/Code.gs`. The member
bridge above answers "is this person a member"; this one supplies the
website's editable content — schedule, prop firms, team, FAQs, bundles,
stats, results, announcements, trade reviews.

## Setup

Paste the file into the Apps Script editor attached to your content
spreadsheet, then **run `setUp`**. It creates every tab with correct headers,
seeds the Schedule tab with the week the site currently shows, generates
`CONTENT_BRIDGE_SECRET`, records `SHEET_ID`, and logs exactly what to paste
into Cloudflare. It is idempotent: re-running never overwrites a tab, a row,
or an existing secret.

Then Deploy → New deployment → Web app (Execute as **Me**, access
**Anyone** — the HMAC is the real gate, an unsigned request gets 401), and
put the `/exec` URL into Cloudflare's `CONTENT_BRIDGE_URL`.

Opening the `/exec` URL in a browser returns
`{"ok":true,"service":"content-bridge","method":"POST"}` and nothing about
your sheet. That exists purely so you can confirm the URL is the right one,
which is the mistake that otherwise costs an afternoon.

## Checking it

`healthCheck` in the function dropdown logs per-tab usable row counts — no
content, only counts. It names the two failures that are otherwise invisible:
a tab that was never created, and rows whose `id` cell is blank (the bridge
drops those, so a full-looking sheet produces an empty website).

## Sheet contract

| Tab | Columns |
|---|---|
| Announcements | id, title, body, link, pinned, created_at |
| TradeReviews | id, ticker, direction, result, r_multiple, notes, image_url, traded_at |
| PropFirms | id, name, url, code, discount, image_url, notes, active |
| Schedule | id, day, session, time_et, host, note, active |
| Team | id, name, role, bio, photo_url, socials, order |
| Faqs | id, question, answer, order |
| Bundles | id, name, price, period, save_badge, features, whop_url, highlight |
| Stats | id, key, value, label |
| Results | id, image_url, caption, order |

Every row needs a non-empty `id`; rows without one are dropped. Extra columns
are ignored, so adding your own is safe. Headers are matched
case-insensitively with spaces folded to underscores.

**Schedule specifics.** `day` is `Mon`–`Fri`. `session` must be exactly
`NYAM`, `NYPM`, `CLASS` or `ASIA` — anything else and the server drops the row,
so that day quietly loses a session. **Leave `host` blank to mark a slot as
off**: it renders struck through (the way Monday 2:30 does now) rather than
vanishing and leaving a gap, and it is excluded from the live countdown and
from the "15 sessions a week" count. `active` = `false` removes a row outright.

## Rotation

Clear the `CONTENT_BRIDGE_SECRET` script property, run `setUp` again to mint a
new one, and update Cloudflare in the same sitting. The sync fails closed
while the two disagree — stale content keeps serving, nothing breaks publicly.
