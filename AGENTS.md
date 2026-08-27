# AGENTS.md — Shared Brain for Every AI Instance

Every OpenCode instance, agent, or subagent that touches this repository is
governed by this file. **Read it fully before doing anything.** Then read
`.opencode/board.md` (who is working on what right now) and skim
`.opencode/decisions.md` (why things are the way they are).

If you ever conflict with another instance, re-read the Coordination Protocol
below — overlap is always a protocol failure, not an accident.

---

## What this repository is

One codebase, two public brands, deliberately kept separate:

| Branch  | Brand            | Role                                                        |
|---------|------------------|-------------------------------------------------------------|
| `main`  | **St**           | Production site. Root = St-branded pages. `/pj/` folder = static TEST PREVIEW of PJ's site (noindex). |
| `pj`    | **PJ Trades x St** | PJ's full site (rebrand + newest features). Becomes production only when the owner says so. |

Other branches (`codex/*`, `claude/*`) are historical experiments. Do not base
work on them.

Local checkouts registered for multi-agent work (see Instance Registry):
- `C:\Users\splys\OneDrive\Vjm Website Repo\vjm-site` — original OneDrive copy
- `C:\Users\splys\vjm\st-site` — clone on `main` (St instance)
- `C:\Users\splys\vjm\pj-site` — clone on `pj` (PJ instance)

## Non-negotiables (any violation = revert)

1. **No secrets in code, ever.** Keys live in Cloudflare env vars / GitHub
   Secrets. `.env.example` holds placeholders only.
2. **Never invent facts**: no fake prices, prop-firm payout terms, member
   counts, testimonials, urgency ("spots left"), or team bios. Owner data
   comes from the Google Sheets CMS or explicit owner instruction.
3. Every trading-related claim stays educational; keep "not financial advice"
   disclaimers intact.
4. Backend (`functions/`, `apps-script/`, `migrations/`, `_headers`,
   `package.json`) is owner-approved territory — do not modify without an
   explicit instruction covering those paths.
5. `main` root pages = St brand. Never rebrand them to PJ. `/pj/*` copies are
   generated FROM branch `pj` — never hand-edit them.
6. Run the test suite before pushing from branch `pj`:
   `npm test` must be green.

## Coordination Protocol (how instances share one brain)

Sync happens through git. Your awareness happens through these files. Follow
all six steps every session:

1. **SYNC IN** — `git pull origin <branch>` at start. Read `AGENTS.md` →
   `.opencode/board.md` → tail of `.opencode/decisions.md`.
2. **REGISTER** — add yourself to the Instance Registry below (or fix your
   entry if hostname/path changed).
3. **CLAIM** — before touching anything, add a row to `.opencode/board.md`
   with: your instance name, branch, the exact file set you intend to change,
   and what you're trying to achieve (one sentence of intent). Commit and
   push this claim *before* starting work.
4. **STAY IN LANE** — edit only your claimed file set. Need something outside
   it? Do NOT grab it. Add a "Request" row on the board describing what you
   need and continue with what you can. Whoever owns that area picks it up.
5. **REPORT** — when done: move your board row to Done with a one-line
   result, append any durable decision to `.opencode/decisions.md`
   (decision + why + date), run tests if applicable, commit, `git push`.
6. **COLLISION RULE** — if a pull brings changes to files you claimed but
   didn't touch, stop and reconcile on the board before continuing. If two
   entries claim overlapping files, the later timestamp yields; re-claim after
   the earlier one moves to Done.

**Claim granularity:** a page or feature area (e.g., "prop-firms.html",
"premium dashboard tab"), never "the whole site".

## Instance Registry

| Instance | Machine / Path | Branch | Last seen |
|----------|----------------|--------|-----------|
| Codex /root | C:\\Users\\splys\\OneDrive\\Vjm Website Repo\\vjm-site | pj | 2026-08-27 |
| (register yourself here on first use) | | | |

## Where knowledge lives

| Question                        | File                          |
|---------------------------------|-------------------------------|
| Who is doing what right now?    | `.opencode/board.md`          |
| Why was X built this way?       | `.opencode/decisions.md`      |
| How do deployments/env vars work? | `docs/DEPLOYMENT.md`, `.env.example`, `docs/DISCORD-INTEGRATION.md` |
| Improvement backlog             | `docs/BRAINSTORM-BACKLOG.md`, board "Queued" rows |
