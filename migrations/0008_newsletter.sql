-- Migration 0008: the newsletter list.
--
-- The site collects an email in exactly one place (the newsletter form) and
-- this is where it lands. The list lives in the owner's own D1, not in a
-- third-party ESP, for the same reason analytics did: no vendor account, no
-- processor to disclose, and no address book leaving this infrastructure.
--
-- Two things here are legal requirements, not conveniences:
--
--   * `unsub_token` — every subscriber gets a unique, unguessable token at
--     signup. It is what makes one-click unsubscribe possible from an email
--     footer without asking the reader to log in or retype anything, which is
--     what CAN-SPAM §316.5 and the List-Unsubscribe header both assume.
--   * `status` — unsubscribing sets this to 'unsubscribed'; it never deletes
--     the row. A deleted row would be silently re-addable by the next form
--     submission or list import, which is the classic way an opt-out gets
--     undone. Suppression has to outlive the subscription.
--
-- Deliberately NOT stored: IP address, user agent, or any behavioural profile.
-- `source` records which form the address came from (the page), because
-- "where did you get my address" must be answerable.

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL,                     -- normalised: trimmed + lowercased
  first_name      TEXT,
  status          TEXT NOT NULL DEFAULT 'subscribed',-- 'subscribed' | 'unsubscribed'
  source          TEXT,                              -- the form/page it came from
  unsub_token     TEXT NOT NULL,                     -- unguessable, per subscriber
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  unsubscribed_at TEXT
);

-- One row per address. Re-submitting an address must update the existing row
-- (an ON CONFLICT upsert), never append a duplicate — otherwise unsubscribing
-- clears one row and the person keeps receiving mail from another.
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers (email);
-- The unsubscribe link looks a subscriber up by token alone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_token ON newsletter_subscribers (unsub_token);
-- "Who do I actually send to" is the only query that matters at send time.
CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers (status, created_at);
