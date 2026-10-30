-- 0020_notifications_not_sending: tell the publisher when email isn't going out (SPEC §8).
--
-- When the provider refuses the account outside a send, or the account check finds a refusal
-- before anything is sent, nobody is there to see it, so the publisher hears of it through the
-- notifications they already get, as a `not_sending` notice with no send and no import, at
-- most one a UTC day: its episode is the day's start, and the partial unique index keeps one
-- row a day, as the `sandbox` notice does. `notifications.kind`'s CHECK doesn't admit it and a
-- STRICT table's CHECK can't be altered, so the table is rebuilt with `not_sending` added,
-- every row and column carried over, `sent_to` and its check included, so a notification that
-- has reached some of its addresses never mails them again.
--
-- What can't be recovered: nothing. Every row is copied as it was.

CREATE TABLE notifications_next (
  send_id    TEXT REFERENCES sends (id),       -- null for a test, an import notice, and an account notice
  import_id  TEXT REFERENCES imports (id),     -- set only for an import notice
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'stuck', 'wedged', 'missed', 'test', 'import', 'sandbox', 'not_sending')),
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
  CHECK ((send_id IS NULL) = (kind IN ('test', 'import', 'sandbox', 'not_sending'))),
  CHECK ((import_id IS NULL) = (kind <> 'import'))
) STRICT;

INSERT INTO notifications_next (send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at, sent_to)
  SELECT send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at, sent_to FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
CREATE UNIQUE INDEX idx_notifications_sandbox_day ON notifications (episode) WHERE kind = 'sandbox';
CREATE UNIQUE INDEX idx_notifications_not_sending_day ON notifications (episode) WHERE kind = 'not_sending';
