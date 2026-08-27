# Decisions Log (append-only)

Format: `- YYYY-MM-DD — decision — why — decided by`
Newest at the bottom. Read the last ~20 lines at session start.

- 2026-08-24 — AI narrative uses Cloudflare Workers `AI` binding, no external LLM key — owner wants free-tier smart APIs, no Anthropic billing; Workers AI free allocation covers assistant + market brief — ox-alpha
- 2026-08-24 — prop-firms.html stays 100% owner-data driven, zero hardcoded claims — accuracy pass found all facts live in the Google Sheet; code only renders — ox-alpha
- 2026-08-24 — /pj static preview lives on main as noindex copies generated from branch pj — owner wants both brands live simultaneously during testing; canonicals stripped so Google ignores previews — ox-alpha
- 2026-08-24 — Multi-agent work syncs via git commits to .opencode/board.md + decisions.md, not live file sharing — cross-machine instances (OpenCode runs off-box) can't share memory; versioned blackboard survives OneDrive and works across clones — ox-alpha
- 2026-08-27 — The PJ video facade uses a locally derived opening-frame poster, not a third-party thumbnail — the poster accurately previews the recording and is independent of YouTube availability — Codex /root
