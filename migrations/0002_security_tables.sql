-- Migration 0002: rate limiting + audit events + session revocation hooks.
-- Bind the database as RATELIMIT_DB (or reuse RESEARCH_DB) in Cloudflare Pages.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_minute INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window
  ON rate_limits (window_minute);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  subject_hash TEXT,          -- truncated SHA-256; never raw codes/handles
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events (created_at DESC);
