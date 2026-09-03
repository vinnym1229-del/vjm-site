-- Optional D1 persistence for the VJM Research Engine.
-- Bind the database as RESEARCH_DB in Cloudflare Pages, then apply this migration.

CREATE TABLE IF NOT EXISTS research_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  as_of TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_snapshots_lookup
  ON research_snapshots (cache_key, created_at DESC);

CREATE TABLE IF NOT EXISTS research_latest (
  cache_key TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  as_of TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
