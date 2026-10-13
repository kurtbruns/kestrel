-- 0005_imports: bringing an existing list in (SPEC §7, §8).
--
-- An import confirms a subscriber without their confirming here, on the strength of the
-- previous service's evidence and the publisher's attestation, so the record has to say,
-- per subscriber, how they joined, and keep each import's own record beside the list.
--
-- `imports` is that record: who committed it (a person, with their login, or a service
-- token, which has none), when, the attestation's version when one was given, the file's
-- name and SHA-256, and how many rows each outcome applied to. It never holds a
-- subscriber's address, so an erasure has nothing to reach here: what an import brought in
-- about a person lives on their subscriber row and leaves with it. `plan_hash` is UNIQUE
-- because it is the commit's idempotency key: a commit replayed after a lost answer finds
-- the import already made and returns it instead of applying it twice.

CREATE TABLE imports (
  id                  TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  principal_kind      TEXT NOT NULL CHECK (principal_kind IN ('human', 'service')),
  principal_email     TEXT CHECK (principal_email = lower(principal_email)),
  attestation_version INTEGER,                  -- null when no row was confirmed
  file_name           TEXT NOT NULL,
  file_sha256         TEXT NOT NULL,
  plan_hash           TEXT NOT NULL UNIQUE,
  counts              TEXT NOT NULL CHECK (json_valid(counts)),  -- JSON: rows by outcome
  suppressions_added  INTEGER NOT NULL DEFAULT 0,
  CHECK ((principal_kind = 'human') = (principal_email IS NOT NULL))
) STRICT;

-- How each subscriber joined, beside their consent state and never a fourth state of it.
-- `origin` and `opt_in` are where and how consent was collected; `consent_evidence` is the
-- proof (a source's consent columns verbatim, or the IP a confirmation here came from),
-- which nothing reads to decide anything; `import_id` names the import that confirmed or
-- added the row, and is what makes a row read as imported whatever its file claimed. A
-- confirmation recorded here clears it, since the consent is then this app's own.
--
-- The defaults are the backfill: every subscriber before this migration joined through
-- this app's double opt-in (or is on the way to it), so it reads as `kestrel`, `double`.
ALTER TABLE subscribers ADD COLUMN origin TEXT NOT NULL DEFAULT 'kestrel'
  CHECK (origin = lower(origin) AND length(origin) BETWEEN 1 AND 40);
ALTER TABLE subscribers ADD COLUMN opt_in TEXT NOT NULL DEFAULT 'double'
  CHECK (opt_in IN ('double', 'single', 'unknown'));
ALTER TABLE subscribers ADD COLUMN consent_evidence TEXT
  CHECK (consent_evidence IS NULL OR json_valid(consent_evidence));
ALTER TABLE subscribers ADD COLUMN import_id TEXT REFERENCES imports (id);

-- The publisher is told of an import Claude commits (SPEC §8) through the notifications
-- they already get, rather than a second table. `notifications.kind`'s CHECK doesn't admit
-- it and a STRICT table's CHECK can't be altered, so the table is rebuilt with `import`
-- added and an `import_id` for it: an import notice has an import and no send, a test has
-- neither, and every other kind has a send. Each import is told at most once.
CREATE TABLE notifications_next (
  send_id    TEXT REFERENCES sends (id),       -- null for a test and an import notice
  import_id  TEXT REFERENCES imports (id),     -- set only for an import notice
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'stuck', 'wedged', 'missed', 'test', 'import')),
  episode    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'unaddressed', 'cleared')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (send_id, kind, episode),
  UNIQUE (import_id),
  CHECK ((send_id IS NULL) = (kind IN ('test', 'import'))),
  CHECK ((import_id IS NULL) = (kind <> 'import'))
) STRICT;

INSERT INTO notifications_next (send_id, kind, episode, status, attempts, error, created_at, updated_at)
  SELECT send_id, kind, episode, status, attempts, error, created_at, updated_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
