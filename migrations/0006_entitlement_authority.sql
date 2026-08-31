-- Migration 0006: make D1 the single authority for "is this member allowed in,
-- and until when", and give a live session something to be revoked against.
--
-- Before this migration, cancellation and expiry were spread across three
-- places that could disagree indefinitely:
--
--   1. whop_codes (D1)      — what the Whop webhook recorded.
--   2. The owner's Google   — what code sign-in actually trusted, updated by
--      Sheet (member bridge)  hand from a plaintext code posted to Discord.
--   3. The signed cookie    — stateless for up to 7 days (30 max), so a
--                             revocation never reached anyone already signed in.
--
-- A member could be revoked in (1) and still active in (2); and even revoking
-- both did nothing to (3). This migration adds the columns the auth handlers
-- need to close all three gaps.
--
-- Apply with:  npx wrangler d1 execute <DB> --file migrations/0006_entitlement_authority.sql
-- Safe to re-run: every statement is idempotent except the ALTERs, which
-- SQLite will reject with "duplicate column name" if already applied.

-- The `mr` claim carried by every session issued after this change:
-- substr(code_hash, 1, 16). Both sign-in paths (access code and Google) now
-- derive it identically, so ONE indexed lookup answers "is the member behind
-- this cookie still entitled?" without the cookie carrying anything sensitive.
ALTER TABLE whop_codes ADD COLUMN member_ref TEXT;

-- Monotonically increasing per-member session generation. Every session is
-- signed with the epoch that was current when it was minted (`sv`). Bumping
-- this invalidates every outstanding cookie for that member immediately —
-- that is what makes revocation reach a session that is already signed in,
-- and it also allows a forced re-auth without revoking entitlement.
ALTER TABLE whop_codes ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 1;

-- When access was withdrawn, and where the row came from. Both are for the
-- owner's forensics; no auth decision reads them.
ALTER TABLE whop_codes ADD COLUMN revoked_at TEXT;
ALTER TABLE whop_codes ADD COLUMN provisioned_at TEXT;
ALTER TABLE whop_codes ADD COLUMN source TEXT;   -- 'whop' | 'sheet' | NULL (pre-0006)

-- Backfill the ref for every row that already exists, so members holding a
-- code minted before this migration are covered by the revocation check the
-- moment they sign in again.
UPDATE whop_codes SET member_ref = substr(code_hash, 1, 16) WHERE member_ref IS NULL;

-- Status vocabulary alignment. The webhook used to write 'delivered' (meaning
-- "the code reached the owner's Discord channel"), while the Sheet bridge
-- speaks 'active'/'renewed'. Now that D1 — not the Sheet — decides access,
-- one vocabulary is used everywhere: pending | active | renewed | revoked.
-- 'delivered' is still accepted as live by the code (see _lib/session.js
-- LIVE_ENTITLEMENT_STATUSES) so a half-applied migration cannot lock anyone
-- out, but no new row will be written with it.
UPDATE whop_codes SET status = 'active' WHERE status = 'delivered';

CREATE INDEX IF NOT EXISTS idx_whop_codes_member_ref ON whop_codes (member_ref);
CREATE INDEX IF NOT EXISTS idx_whop_codes_whop_member ON whop_codes (whop_member_id);
CREATE INDEX IF NOT EXISTS idx_whop_codes_discord ON whop_codes (discord);
