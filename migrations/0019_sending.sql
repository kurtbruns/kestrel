-- 0019_sending: whether email is getting out (SPEC §9).
--
-- One row, written whenever the provider answers a test, a confirmation, a list send, or a
-- notification, and by the account check: `unproven` until the provider takes an email,
-- `working` while the last one it was asked to take it took, `refusing` while it refuses the
-- account for a reason that won't clear on its own. `since` is when it entered that state.
-- The last email taken (`last_accepted_at`, and what it was, `last_accepted_by`) is kept
-- across a refusal, so the editor can say when the provider last took one. A refusal keeps
-- its cause, what found it, and the provider's words.
--
-- The row starts as `working` when the app's own records show email went out: a send the
-- provider took a recipient of, or a subscriber who confirmed through a link this instance
-- mailed. So an instance that was live before this release keeps its signups open. A test
-- leaves no record and so counts for nothing here; the next one sets it. A delivered
-- notification counts for nothing either, since it may have gone through Cloudflare's email
-- rather than the provider. The provider's own 24-hour count is never read: it is zero on a
-- quiet day.
--
-- What can't be recovered: nothing. The table is new.

CREATE TABLE sending (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  state            TEXT NOT NULL CHECK (state IN ('unproven', 'working', 'refusing')),
  since            INTEGER NOT NULL,
  last_accepted_at INTEGER,
  last_accepted_by TEXT CHECK (last_accepted_by IN ('test', 'confirmation', 'list', 'notification')),
  refusal_cause    TEXT,
  refusal_found_by TEXT
                     CHECK (refusal_found_by IN ('test', 'confirmation', 'list', 'notification', 'account_check')),
  refusal_error    TEXT,
  refusal_at       INTEGER,
  CHECK ((last_accepted_at IS NULL) = (last_accepted_by IS NULL)),
  CHECK ((state = 'refusing') = (refusal_cause IS NOT NULL)),
  CHECK ((refusal_cause IS NULL) = (refusal_found_by IS NULL)),
  CHECK ((refusal_cause IS NULL) = (refusal_at IS NULL)),
  CHECK (state <> 'working' OR last_accepted_at IS NOT NULL)
) STRICT;

INSERT INTO sending (id, state, since, last_accepted_at, last_accepted_by)
  SELECT 1,
         CASE WHEN at IS NULL THEN 'unproven' ELSE 'working' END,
         COALESCE(at, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
         at,
         CASE WHEN at IS NULL THEN NULL ELSE by END
  FROM (
    SELECT at, by FROM (
      SELECT MAX(updated_at) AS at, 'list' AS by FROM deliveries WHERE status = 'accepted'
      UNION ALL
      SELECT MAX(confirm_sent_at), 'confirmation' FROM subscribers
        WHERE status = 'confirmed' AND confirm_sent_at IS NOT NULL AND import_id IS NULL
    )
    ORDER BY at IS NULL, at DESC
    LIMIT 1
  );
