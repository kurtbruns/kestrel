-- 0014_send_acts: who acted on a send, and when (SPEC §6, §11, Who acted).
--
-- A send's acts are a log: each schedule, Send now, reschedule, cancel, and Resolve adds a row with
-- who acted (the who-acted shape as JSON: `{"kind":"human","email":…,"client":…}` or
-- `{"kind":"service","token_id":…,"client":null}`) and when, written in the same batch as the
-- change it records. A schedule, Send now, or reschedule keeps the fire time it set, and a Resolve
-- the resolution it chose. The send view's latest actor of each act is read from it.
--
-- What can't be recovered: no act was recorded before this, so a send made before it has no
-- rows, and reads as acted on by no one recorded.

CREATE TABLE send_acts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id    TEXT NOT NULL REFERENCES sends (id),
  act        TEXT NOT NULL CHECK (act IN ('schedule', 'send_now', 'reschedule', 'cancel', 'resolve')),
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL
             CHECK (json_valid(actor) AND json_extract(actor, '$.kind') IN ('human', 'service')),
  fire_at    INTEGER CHECK ((fire_at IS NOT NULL) = (act IN ('schedule', 'send_now', 'reschedule'))),
  resolution TEXT
             CHECK ((resolution IS NOT NULL) = (act = 'resolve')
                    AND (resolution IS NULL OR resolution IN ('unsent', 'accepted')))
) STRICT;

CREATE INDEX idx_send_acts_send ON send_acts (send_id, id);
