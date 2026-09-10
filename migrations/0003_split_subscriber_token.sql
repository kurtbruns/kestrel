-- 0003_split_subscriber_token — split the single subscriber token into two (SPEC §7).
--
-- A subscriber used to carry ONE token doing two unrelated jobs: confirm and
-- unsubscribe. subscribe() rotates that token when a pending/unsubscribed address
-- re-arms, so the one-click unsubscribe link embedded in already-delivered mail
-- (built from the *current* token) went dead the moment a returning subscriber
-- re-subscribed — a broken unsubscribe in mail already sitting in inboxes, which
-- undercuts I2 and the bulk-sender one-click requirement (§9).
--
-- Split into two columns so the durable one is never rotated:
--   unsub_token   — durable; embedded in delivered mail; NEVER rotated, including
--                   across an unsubscribe→resubscribe cycle. NOT NULL UNIQUE.
--   confirm_token — the one-shot double-opt-in token; rotated on re-arm. Nullable
--                   and separately unique (its one-shot property is enforced by
--                   confirm() gating on status='pending', not by clearing it).
--
-- SQLite's ALTER can't drop the old column's NOT NULL/UNIQUE to make confirm_token
-- nullable, so rebuild the table (create → copy → drop → rename). Both new columns
-- are backfilled from the old `token`, so every unsubscribe link already delivered
-- keeps resolving (its token is now this subscriber's durable unsub_token).

CREATE TABLE subscribers_new (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token   TEXT UNIQUE,                 -- one-shot double opt-in; rotated on re-arm
  unsub_token     TEXT NOT NULL UNIQUE,        -- durable; embedded in delivered mail; never rotated
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  unsubscribed_at INTEGER
);

INSERT INTO subscribers_new
  (id, email, status, confirm_token, unsub_token, created_at, confirmed_at, unsubscribed_at)
SELECT id, email, status, token, token, created_at, confirmed_at, unsubscribed_at
  FROM subscribers;

DROP TABLE subscribers;
ALTER TABLE subscribers_new RENAME TO subscribers;

CREATE INDEX idx_subscribers_status ON subscribers (status);
