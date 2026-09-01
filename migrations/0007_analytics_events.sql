-- Migration 0007: first-party funnel analytics.
--
-- The site had no analytics of any kind, and the alternative on the table was
-- a third-party tag. This keeps the data in the owner's own D1 instead: no
-- vendor account, no CSP widening, no visitor data leaving this infrastructure,
-- and nothing to disclose to a processor beyond what the privacy page already
-- covers.
--
-- Deliberately NOT stored: IP address, user agent, member id, email, or any
-- other identifier. `visit_id` is a random per-tab value generated in the
-- browser (sessionStorage) purely so the stages of one visit can be joined
-- together in a report; it is not stable across tabs, sessions or devices and
-- maps to nobody.

CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,             -- one of the allowlisted funnel stages
  props      TEXT,                      -- small JSON blob, server-capped
  visit_id   TEXT,                      -- random per-tab, non-identifying
  path       TEXT,                      -- page the event fired on
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reporting is "count stage X over a date range", so index the pair.
CREATE INDEX IF NOT EXISTS idx_analytics_name_time ON analytics_events (name, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_visit ON analytics_events (visit_id);
