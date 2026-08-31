# Paywall exposure: what is public, and what to do about it

**Status:** decision pending — owner's call. This document measures the problem
and prices the options. Nothing in `functions/_middleware.js` has been changed.

**Reproduce every number here:** `node tools/paywall-audit.mjs` (add `--json`
for machine output). `tests/paywall-audit.test.mjs` keeps the measurement
honest and fails the build if paid content ever escapes a gated region.

---

## 1. The one-sentence problem

The edge gate works. It is also irrelevant to the largest exposure, because
**every paid lesson body is committed in plain text to a public repository.**

`functions/_middleware.js` strips `.gated-content` from the HTML before it
leaves Cloudflare for a visitor who fails `authorizeResource()`. An anonymous
`curl` of `/options-lab.html` gets a hollow page. But the same lesson bodies
sit verbatim in four `.html` files that anyone can read on GitHub in a browser,
`git clone` in three seconds, or fetch through the GitHub API without ever
touching the site. The paywall protects one door of a building with a glass
wall.

## 2. What is exposed today — measured, not estimated

Audit run against the working tree (`node tools/paywall-audit.mjs`):

| page | gated regions | gated lessons | free lessons | worked cases | paid words | paid markup | page source |
|---|---:|---:|---:|---:|---:|---:|---:|
| `futures-dissection.html` | 3 | 43 | 7 | 3 | 9,749 | 86 KB | 116 KB |
| `options-lab.html` | 4 | 51 | 0 | 3 | 11,381 | 99 KB | 153 KB |
| `psychology-enhancer.html` | 13 | 62 | 0 | 3 | 16,048 | 157 KB | 203 KB |
| `stock-breakdown.html` | 4 | 46 | 0 | 3 | 12,789 | 112 KB | 128 KB |
| **total** | **24** | **202** | **7** | **12** | **49,967** | **454 KB** | **599 KB** |

Read that as:

- **202 paid lessons** are gated at the edge and readable in public source.
- **All twelve worked cases** — the long-form, fully-computed examples that are
  the most expensive thing on this site to produce — are in public source.
- **49,967 words** of paid prose (roughly a 200-page book) and **465,322 bytes**
  of paid markup are in the public repository right now.
- **Seven lessons are free by design** (futures Level 1) and one essay
  (psychology). That is the entire intended free tier, and the audit knows it
  so "zero exposed" can't be faked by widening the exemption.
- **Zero paid lessons and zero worked cases sit outside a gated region.** The
  server-side gate covers everything it is supposed to cover. This is the part
  that is working, and the part not to break.

The value at risk is not 454 KB of bytes. It is the only thing on the site that
a competitor cannot generate in an afternoon.

## 3. Why the existing defenses do not address this

**`.gated-content hidden` (client-side).** Cosmetic. `hidden` is a CSS
attribute; the text is in the DOM. This was the original hole and is why the
middleware exists.

**The middleware strip (server-side).** Real enforcement, and correct: it runs
`authorizeResource(session, path, env)`, so a $100 Futures Core buyer opening
`/options-lab` takes the same stripped path an anonymous visitor does. Its
scope is exactly one thing — *HTTP responses from this origin*. GitHub is a
different origin. The middleware cannot strip anything from a `git clone`.

**`noindex` / `X-Robots-Tag`.** These ask *cooperating search crawlers* not to
list a URL. They are a request, not access control; they do not affect
non-crawler fetches at all; and they are aimed at the site, not at the
repository. A repository that is public is discoverable by GitHub's own code
search regardless of what `_headers` says. `noindex` reduces the chance a
stranger *stumbles onto* the content. It does nothing about anyone who goes
looking, and paid course text is exactly what people go looking for.

**Summary of the gap.** Three defenses all sit on the request path. The
exposure is not on the request path.

## 4. The ordering trap (read before choosing anything)

Two failure modes make expensive work worthless:

1. **Rotating content out of the repo while the history stays public is
   pointless.** Deleting the lesson bodies in a new commit removes them from
   `HEAD` and from nothing else. `git log -p`, any commit permalink, the GitHub
   API, and every existing clone still carry the full text. A "remove the paid
   content" commit is, on a public repo, a signed advertisement of exactly which
   commit to check out. If the content is being removed *because it is secret*,
   the history must be rewritten (or the repo replaced) in the same operation —
   and even then, prior clones and forks are gone forever.

2. **Going private while the content is also served unauthenticated is
   pointless.** A private repo protects nothing if `curl https://site/options-lab`
   returns the lessons. That direction is currently sound — the audit reports
   zero paid lessons outside a gated region — but it is a property that can
   regress silently the next time a page is edited. `tests/paywall-audit.test.mjs`
   is what keeps it from regressing; it must stay in `npm test`.

The corollary: **assume what is already public is already gone.** Anyone who
cloned this repo before it is locked down keeps a complete copy of all 202
lessons. Nothing below can retrieve that. Every option here protects *future*
content and future editions, not the current text.

## 5. Option A — make the repository private

**What it is.** Repository settings → change visibility → private. Cloudflare
Pages builds from private repos via the GitHub app; the deployment does not
change.

**What it fixes.** All future commits. New lessons, revisions, and the next
course are not published to the world at the moment they are written. This is
the only option that addresses the actual exposure vector directly.

**What it does not fix.**
- Existing git history remains inside the repo (now only visible to
  collaborators — fine) but **every copy already cloned or forked stays as it
  is**, forever, outside anyone's control.
- GitHub may retain cached views of previously-public commits for some time;
  purging those requires a support request, and is only worth doing as part of a
  history rewrite.
- It does not make the site's own serving correct — that is the middleware's job,
  already done.

**Cost.** Minutes. No code changes. Some loss of public-repo conveniences
(anonymous issue reports, public CI badges, drive-by contributions) that this
project does not appear to use.

**Risk.** Effectively zero. Nothing in the deploy path depends on the repo being
public.

**Optional extra: rewriting history.** `git filter-repo` to purge the lesson
bodies from every commit, then force-push, then ask GitHub Support to expire
cached objects. Cost: half a day plus coordination. Risk: every clone and open
PR breaks; every commit SHA changes; any reference to a commit in docs or
tooling dies. Value: real only if the content is still considered secret *and*
you believe nobody has cloned it. Given point 4's corollary, that belief is hard
to hold. **Do this only if the answer to "has anyone cloned it?" is a
well-evidenced no.**

## 6. Option B — move lesson bodies out of the repo into D1 or KV

**What it is.** The four pages ship as skeletons; the paid prose lives in
Cloudflare storage and is injected at the edge only after `authorizeResource()`
says yes. The repo then holds no paid text at all — for new content, from the
day it is written.

This is real work with a real chance of breaking a working gate, so the shape is
sketched concretely rather than waved at.

### 6.1 Extraction step (`tools/lesson-extract.mjs`, new)

Reuses the same depth-tracked region parser that `tools/paywall-audit.mjs`
already implements (`findRegions(html, hasClass('gated-content'))`) — the
parser is the reason that tool exists in a shared, tested form.

For each of the four pages it would:

1. Find the 24 `.gated-content` regions, in document order.
2. Write each region's inner HTML to a seed file, keyed `page:index`.
3. Rewrite the page in place, replacing each region's inner HTML with nothing
   and adding an addressing attribute:
   `<div class="gated-content" data-block="options-lab:2" hidden></div>`.
4. Re-run `node tools/paywall-audit.mjs`, which must then report **0 paid
   words in public source** — the extraction is verified by the same measurement
   that identified the problem.

The seed output is content, not code: it must go somewhere that is not this
repo (a private bucket, or straight into the store via `wrangler`), or the whole
exercise is undone.

### 6.2 Storage

**D1** (`migrations/0007_lesson_blocks.sql`, following the existing numbered
convention; the database is already bound as `RESEARCH_DB`):

```sql
CREATE TABLE IF NOT EXISTS lesson_blocks (
  page          TEXT NOT NULL,   -- 'options-lab.html'
  block_index   INTEGER NOT NULL,-- 0-based, document order
  required_tier TEXT NOT NULL,   -- 'futures_core' | 'complete' — mirrors RESOURCE_TIERS
  html          TEXT NOT NULL,   -- the region's inner HTML, pre-sanitized at ingest
  words         INTEGER NOT NULL,-- lets the audit keep measuring after extraction
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (page, block_index)
);
```

One `SELECT block_index, html FROM lesson_blocks WHERE page = ?1 ORDER BY
block_index` per authorized request. Largest page is 157 KB across 13 rows —
comfortably inside D1's limits, but it is 157 KB of row data on every authorized
page view.

**KV** is the better fit for this shape of data: one key per page
(`lesson:options-lab.html` → the page's blocks as one JSON blob), read from the
edge cache rather than a SQL round-trip, and no per-row overhead. Trade-off: KV
writes are eventually consistent (a content edit can take up to ~60s to appear
everywhere) and KV has no query surface, so per-lesson analytics or drip
scheduling would push back toward D1. **If the only requirement is "serve the
right blob to an authorized reader", use KV. Choose D1 only if lessons need to
be queried, not just fetched.**

### 6.3 Injection hook

In `functions/_middleware.js`, the branch that already exists:

```js
if (authorized) {
  const blocks = await loadBlocks(env, url.pathname);   // KV get / D1 select
  if (!blocks) return degraded(response, headers);      // see 6.4
  return new HTMLRewriter()
    .on('[data-block]', new InjectLessonBody(blocks))   // setInnerContent(html, {html:true})
    .transform(new Response(response.body, { ...headers }));
}
// unauthorized path: unchanged, still the .gated-content strip
```

Two properties matter and both are cheap to preserve:

- The **unauthorized path does not change at all**. Empty skeleton in, empty
  skeleton out. Whatever goes wrong with injection, the gate cannot leak.
- The store is read **after** `authorizeResource()`, never before, so an
  unauthorized request never causes a fetch of paid content.

### 6.4 What breaks if the binding is absent

This is the sharp edge, and it is the reason this option is not free. Today a
missing binding degrades a *feature* (`/api/content` returns a 503 with a hint).
After this migration, a missing or empty binding means **a paying member's
course page renders blank** — the content is not in the HTML any more, and there
is no fallback copy anywhere in the deployment. The failure mode moves from
"research tool is offline" to "the thing they paid for is gone", on a preview
deployment, a new Pages project, a rolled-back binding, or a partially-applied
seed.

Minimum mitigations before this ships:

- A `degraded()` path that serves a clear, honest "lessons are temporarily
  unavailable — this is our fault, your access is intact" page rather than an
  empty shell that looks like a revoked entitlement.
- A startup/deploy smoke check asserting all 24 blocks are present, per page,
  per environment.
- A staged rollout: keep the bodies in the HTML *and* in the store for one
  release, verify injection against a real session, then remove them from the
  HTML in a separate commit.

**Cost.** Realistically 1–2 days for extraction, schema, seeding, injection,
degraded path, smoke checks and a staged rollout — plus ongoing friction
forever: lesson edits stop being reviewable diffs in a pull request and become a
sync operation against a store, with no history and no review unless that is
built too.

**Risk.** The highest of any option here, and it lands on the one component
that currently works.

## 7. Option C — do nothing

Legitimate, and it should be named rather than assumed away. The content is
already public; a competitor motivated enough to copy 50,000 words has already
been able to for as long as the repo has existed. What buyers actually pay for
may be the structure, the updates, the Discord, and the tooling, not the prose.

**Cost:** zero. **Risk:** the exposure compounds — every new lesson written is
published free at the moment of commit, and the gap between what the paywall
claims and what it does keeps growing.

## 8. Cost and risk at a glance

| Option | Work | Risk to the working gate | Fixes existing exposure | Fixes future exposure |
|---|---|---|---|---|
| A. Private repo | minutes | none | no | **yes** |
| A+. History rewrite | ~half a day + coordination | none (breaks clones/forks) | partially — never for existing clones | yes |
| B. D1/KV injection | 1–2 days + ongoing friction | **high** | no (history still holds it) | yes |
| C. Do nothing | none | none | no | no |

Note what the table says about B: it is the most expensive option and it does
**not** fix the existing exposure on its own. Without A, extracting the lessons
just leaves them in the git history of a public repo — trap #1 in section 4.

## 9. Recommendation

**Do A now. Do not do B yet.**

1. **Make the repository private today.** It is minutes of work, zero risk, and
   it is the only step that actually addresses the vector — everything written
   from that point on stops being published for free. Every hour it waits, more
   content ships into the public record.
2. **Keep the middleware exactly as it is.** It is the enforcement point, it is
   correct, and it is tested. Do not rewire it as part of this.
3. **Keep `tests/paywall-audit.test.mjs` in `npm test`.** It is what guarantees
   the second half of the ordering trap stays closed: paid content never leaves
   a gated region, so a private repo is not undermined by the site itself.
4. **Treat the currently-published text as already leaked.** Do not spend a day
   on a history rewrite to protect 50,000 words that have been publicly
   cloneable for the life of the repository — unless there is real evidence
   nobody took a copy, in which case do the rewrite *at the same time* as going
   private, never after a "remove the content" commit.
5. **Revisit B when there is a second reason for it** — per-lesson updates,
   drip release, real content analytics, or a second product sharing the same
   lessons. Storage-backed lessons are a good architecture for those. As a
   security measure alone, it is a day of high-risk surgery on a working gate
   that leaves the existing exposure untouched.

The honest framing: making the repo private is the fix; moving the content to
D1/KV is an architecture change that happens to also fix it, at fifty times the
cost and with a real chance of breaking what works.

## 10. Keeping this measured

- `node tools/paywall-audit.mjs` — the table in §2, on demand.
- `node tools/paywall-audit.mjs --json` — same, machine-readable.
- Exit status is **1** if any paid lesson or worked case sits outside a gated
  region, or if course markup appears on a page the middleware does not gate.
- `tests/paywall-audit.test.mjs` runs in `npm test` and additionally pins the
  free-tier exemption (futures Level 1 only) and the count of worked cases, so
  the audit cannot be made to pass by relabelling paid content as free.
- The audited page list is parsed out of `GATED_PAGES` in
  `functions/_middleware.js`, so adding a fifth course page to the middleware
  automatically brings it under audit.

If the courses grow substantially, re-run the tool and update §2 — the test
asserts the quoted figure is still in range and will fail rather than let this
document quietly go stale.
