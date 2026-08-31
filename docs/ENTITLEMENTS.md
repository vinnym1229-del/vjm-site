# Entitlements — how the two paid tiers are actually enforced

## The problem this replaced

The site sold two products but authorization knew about neither.

- `verify-premium.js` signed `{ v: 1, mr, dn, exp }` — member ref, Discord
  name, expiry. **No tier claim.**
- `functions/_middleware.js` gated all four course pages on
  `authorized = !!(await getSession(request, env))` — *any* valid session.

So a $100 Futures Only buyer received the entire $129 Complete library. Two
consequences, one technical and one commercial:

1. The products were misrepresented — Futures buyers were sold a subset and
   given the superset.
2. The Core → Complete upgrade was **mathematically impossible to sell**,
   because Core already included everything Complete offered. That upgrade is
   the single largest monetization lever the current funnel has.

## The model

Three tiers, strictly ordered, in `functions/api/_lib/entitlements.js`:

| tier | who | reaches |
|---|---|---|
| `free` | no session | public pages, free Futures L1 |
| `futures_core` | $100/mo Futures Only | Futures track + Psychology/risk |
| `complete` | $129/mo Complete | everything, incl. Stocks, Options, research tools |

A higher tier satisfies every requirement a lower one does; the reverse never
holds. Unknown tiers and unknown requirements both **fail closed**.

Resource → required tier lives in one server-side table (`RESOURCE_TIERS`), so
a newly gated page cannot silently default to "any session will do".

## The three rules worth keeping

1. **Tier is a signed claim.** It is minted where entitlement is established —
   Whop webhook, code sign-in, Google sign-in — and read back out of the HMAC
   token. It is never inferred client-side, and never taken from an unsigned
   header or query parameter.
2. **An unrecognized product grants nothing.** This is the one that matters
   most. Without it, any Whop product whose event reaches the endpoint — a
   cheaper indicator, a one-off, a separately sold add-on — becomes a
   full-course credential.
3. **One declaration point.** Both the page middleware and the paid APIs call
   the same `authorizeResource()`, so the answer cannot drift between them.

## Configuration

See `.env.example` for the copy-paste block. The four variables:

| var | effect |
|---|---|
| `WHOP_PRODUCTS_FUTURES` | product/plan IDs granting `futures_core` |
| `WHOP_PRODUCTS_COMPLETE` | product/plan IDs granting `complete` |
| `WHOP_DEFAULT_TIER` | tier used only while both lists are empty |
| `STRICT_LEGACY_SESSIONS` | `true` rejects pre-tier tokens instead of grandfathering |

### Two deliberate safety valves — read this part

**Strict mode is OFF until you fill in the product lists.** While
`WHOP_PRODUCTS_FUTURES` and `WHOP_PRODUCTS_COMPLETE` are both empty,
`resolveTier()` returns `WHOP_DEFAULT_TIER` (default `complete`) with the
reason `unconfigured_default`. That is on purpose: shipping this must not
black out paying members before the environment is configured. **It also
means the $100 and $129 products remain identical until you set those two
variables.** Setting them is the step that actually fixes the revenue bug —
the code change alone does not.

**Pre-tier sessions are grandfathered.** Tokens minted before this change have
no `t` claim and are treated as `complete` until they expire on their own
(`SESSION_DAYS`, 7 by default, 30 max). No new untiered token can be minted
after this ships, so the window closes by itself and nobody is signed out by
the upgrade. If you would rather close it immediately and have everyone
re-authenticate once, set `STRICT_LEGACY_SESSIONS=true`.

## Rollout order

1. Deploy. Nothing changes for members: unconfigured default is `complete`.
2. Read your real product and plan IDs out of the Whop dashboard.
3. Set `WHOP_PRODUCTS_FUTURES` and `WHOP_PRODUCTS_COMPLETE` in **both**
   Production and Preview.
4. Verify with a real purchase of each product that the minted session carries
   the tier you expect, and that a Futures member is locked out of
   `/stock-breakdown` and `/options-lab`.
5. Once satisfied, optionally set `STRICT_LEGACY_SESSIONS=true` to retire the
   grandfathering window early.

## What this does *not* fix

- **Paid lesson bodies are still in the public GitHub repository.** The edge
  middleware strips `.gated-content` from anonymous HTML responses, but anyone
  can read all 206 lessons straight from source. Tier enforcement is not a
  paywall while that is true — moving paid content into private storage is a
  separate piece of work that needs infrastructure decisions.
- **Cancellation and expiry still have more than one source of truth** (Whop
  writes to D1, code sign-in trusts the Sheet bridge, revokes update D1). The
  expiry check is now enforced on the Google path, but making Whop/D1 the
  single authority and retiring the Sheet bridge is still outstanding.
- **Separate plan-specific checkout URLs.** Both CTAs still point at one
  generic Whop URL, so a buyer cannot actually choose the tier this model now
  distinguishes.
