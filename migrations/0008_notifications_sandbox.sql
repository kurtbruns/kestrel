-- 0008_notifications_sandbox: tell the publisher when the SES sandbox refuses a signup's
-- confirmation (SPEC §7, §8).
--
-- While the SES account is in the sandbox, SES refuses mail to any address not verified in
-- it, so a reader who signs up is told a link is on its way and none arrives. The publisher
-- hears of it through the notifications they already get, as a `sandbox` notice with no send
-- and no import, at most one a UTC day: its episode is the day's start, and the partial
-- unique index keeps one row a day however many signups SES refuses. `notifications.kind`'s
-- CHECK doesn't admit it and a STRICT table's CHECK can't be altered, so the table is rebuilt
-- with `sandbox` added, every row and column carried over.
CREATE TABLE notifications_next (
  send_id    TEXT REFERENCES sends (id),       -- null for a test, an import notice, and a sandbox notice
  import_id  TEXT REFERENCES imports (id),     -- set only for an import notice
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'stuck', 'wedged', 'missed', 'test', 'import', 'sandbox')),
  episode    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'unaddressed', 'cleared')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (send_id, kind, episode),
  UNIQUE (import_id),
  CHECK ((send_id IS NULL) = (kind IN ('test', 'import', 'sandbox'))),
  CHECK ((import_id IS NULL) = (kind <> 'import'))
) STRICT;

INSERT INTO notifications_next (send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at)
  SELECT send_id, import_id, kind, episode, status, attempts, error, created_at, updated_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
CREATE UNIQUE INDEX idx_notifications_sandbox_day ON notifications (episode) WHERE kind = 'sandbox';
