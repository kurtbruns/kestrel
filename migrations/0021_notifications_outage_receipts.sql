-- 0021_notifications_outage_receipts: one outage, at most two emails, and a notice of silence (SPEC §8).
--
-- `not_sending` is now one notice for each stretch email is refusing rather than one a UTC day:
-- its episode is when the refusal began. A second kind, `not_sending_held`, keyed the same way,
-- is the one further email when a post is first held after that notice named none, so a unique
-- index on each kind's episode is what holds an outage to two. `no_receipts` is a send's notice
-- that the provider's receipts may not be reaching the app. The publisher is no longer told of
-- an import, so a pending `import` notice is closed as cleared rather than sent; the kind stays
-- admitted, with the column it reads, since the rows already recorded keep their history and the
-- settings surface may still show the latest. A STRICT table's CHECK can't be altered, so the
-- table is rebuilt, every row and column carried over.
--
-- What can't be recovered: nothing but the pending import notices, which were only ever going
-- to tell of an import already on the record.

CREATE TABLE notifications_next (
  send_id    TEXT REFERENCES sends (id),       -- null for a test, an import notice, and an account notice
  import_id  TEXT REFERENCES imports (id),     -- set only for an import notice
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'stuck', 'wedged', 'missed', 'no_receipts', 'test', 'import', 'sandbox', 'not_sending', 'not_sending_held')),
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
  SELECT send_id, import_id, kind, episode,
         CASE WHEN kind = 'import' AND status = 'pending' THEN 'cleared' ELSE status END,
         attempts, error, created_at, updated_at, sent_to
    FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
CREATE UNIQUE INDEX idx_notifications_sandbox_day ON notifications (episode) WHERE kind = 'sandbox';
CREATE UNIQUE INDEX idx_notifications_not_sending ON notifications (episode) WHERE kind = 'not_sending';
CREATE UNIQUE INDEX idx_notifications_not_sending_held ON notifications (episode) WHERE kind = 'not_sending_held';
