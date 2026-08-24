-- Migration 0003: content platform, Whop entitlements, webhook idempotency.
-- Apply to the same D1 database bound as RESEARCH_DB / RATELIMIT_DB.

CREATE TABLE IF NOT EXISTS site_content (
  content_type TEXT NOT NULL,          -- announcements | trade_reviews | prop_firms
  external_id TEXT NOT NULL,           -- stable id from the owner's sheet
  position INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,               -- JSON, sanitized at ingest
  source_updated_at TEXT,              -- owner-supplied as-of when present
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (content_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_site_content_listing
  ON site_content (content_type, position DESC);

CREATE TABLE IF NOT EXISTS whop_codes (
  code_hash TEXT PRIMARY KEY,          -- sha256(code); raw code never stored
  code_last4 TEXT NOT NULL,
  whop_event_id TEXT UNIQUE,           -- idempotency anchor from Whop
  whop_member_id TEXT,
  whop_product TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,              -- whop | content_announcement | ...
  event_id TEXT NOT NULL,
  note TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, event_id)
);
