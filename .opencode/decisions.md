# Decisions Log (append-only)

Format: `- YYYY-MM-DD — decision — why — decided by`
Newest at the bottom. Read the last ~20 lines at session start.

- 2026-08-24 — AI narrative uses Cloudflare Workers `AI` binding, no external LLM key — owner wants free-tier smart APIs, no Anthropic billing; Workers AI free allocation covers assistant + market brief — ox-alpha
- 2026-08-24 — prop-firms.html stays 100% owner-data driven, zero hardcoded claims — accuracy pass found all facts live in the Google Sheet; code only renders — ox-alpha
- 2026-08-24 — /pj static preview lives on main as noindex copies generated from branch pj — owner wants both brands live simultaneously during testing; canonicals stripped so Google ignores previews — ox-alpha
- 2026-08-24 — Multi-agent work syncs via git commits to .opencode/board.md + decisions.md, not live file sharing — cross-machine instances (OpenCode runs off-box) can't share memory; versioned blackboard survives OneDrive and works across clones — ox-alpha
- 2026-08-27 — The PJ video facade uses a locally derived opening-frame poster, not a third-party thumbnail — the poster accurately previews the recording and is independent of YouTube availability — Codex /root
- 2026-08-29 — prop-firms.html firm-card titles render as `<h2>`, not `<h3>` — the page's only h1 is the hero title and it had no static h2 section heading, so the dynamically-rendered firm cards were a screen-reader heading-level skip (h1 straight to h3); regression test added to site-structure.test.mjs — claude (autonomous maintenance run)
- 2026-08-29 — added tests/member-status-api.test.mjs, the first test coverage for functions/api/check-member-status.js — full sweep of the site found no broken pages, no heading-order/label/contrast gaps left (prior runs already closed those), and no copy errors, so this run's improvement was closing the last untested API route; it pins the "generic response" no-enumeration promise the handler's own comment already made — claude (autonomous maintenance run)
- 2026-08-29 — added tests/auth-google-api.test.mjs, the first test coverage for functions/api/auth-google.js — pins the handler's own documented fix (Google tokeninfo returns email_verified as a string, not a boolean, so a naive === false check let unverified accounts through) plus the aud-replay rejection and the yearly-plan session-expiry cap; verified the regression test fails when the string check is reverted — claude (autonomous maintenance run)
