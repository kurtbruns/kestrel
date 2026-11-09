-- 0023_notifications_unavailable: tell the publisher once when a provider outage passes an hour (SPEC §8).
--
-- A send the provider has been unavailable to for about an hour, at every retry of its backoff,
-- is now told by email, once for each outage: a new kind, `unavailable`, keyed like `refused` on
-- the send and when the outage began, so an outage that ends and later returns is told again. A
-- STRICT table's CHECK can't be altered, so the table is rebuilt, every row and column carried
-- over, with the indexes 0021 made.
--
-- What can't be recovered: nothing. Every row is copied as it was.

CREATE TABLE notifications_next (
  send_id    TEXT REFERENCES sends (id),       -- null for a test, an import notice, and an account notice
  import_id  TEXT REFERENCES imports (id),     -- set only for an import notice
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'unavailable', 'stuck', 'wedged', 'missed', 'no_receipts', 'test', 'import', 'sandbox', 'not_sending', 'not_sending_held')),
  episode    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'unaddressed', 'cleared')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_to    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sent_to)),
  UNIQUE (send_id, kind, episode),
  UNIQUE (import_id),
  CHECK ((send_id IS NULL) = (kind IN ('test', 'import', 'sandbox', 'not_sending', 'not_sending_held'))),
  CHECK ((import_id IS NULL) = (kind <> 'import'))
) STRICT;

INSERT INTO notifications_next (send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at, sent_to)
  SELECT send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at, sent_to
    FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
CREATE UNIQUE INDEX idx_notifications_sandbox_day ON notifications (episode) WHERE kind = 'sandbox';
CREATE UNIQUE INDEX idx_notifications_not_sending ON notifications (episode) WHERE kind = 'not_sending';
CREATE UNIQUE INDEX idx_notifications_not_sending_held ON notifications (episode) WHERE kind = 'not_sending_held';
