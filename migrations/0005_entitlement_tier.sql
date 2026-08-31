-- Migration 0005: record WHICH product a Whop purchase was, as an
-- entitlement tier. The site sells $100 Futures Only and $129 Complete, but
-- whop_codes only ever stored the raw whop_product id — authorization had no
-- tier to read, so every valid session received the whole Complete library
-- (see functions/api/_lib/entitlements.js). This column is the persisted
-- resolution of resolveTier(): 'futures_core' or 'complete'. Rows written
-- before this migration keep NULL and are treated as the legacy default.

ALTER TABLE whop_codes ADD COLUMN tier TEXT;
