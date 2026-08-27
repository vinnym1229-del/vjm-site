-- Migration 0004: richer Whop entitlement data + email-based lookup for
-- Google Sign-In. Email is never stored in plaintext — only its SHA-256
-- hash, same pattern as audit_events.subject_hash.

ALTER TABLE whop_codes ADD COLUMN email_hash TEXT;
ALTER TABLE whop_codes ADD COLUMN plan_name TEXT;
ALTER TABLE whop_codes ADD COLUMN expires_at TEXT;
ALTER TABLE whop_codes ADD COLUMN amount_paid_cents INTEGER;
ALTER TABLE whop_codes ADD COLUMN currency TEXT;
ALTER TABLE whop_codes ADD COLUMN discord TEXT;

CREATE INDEX IF NOT EXISTS idx_whop_codes_email_hash ON whop_codes (email_hash);
