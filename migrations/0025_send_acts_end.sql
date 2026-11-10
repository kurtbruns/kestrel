-- 0025_send_acts_end: the publisher may end a held or wedged send, and its log records who did (SPEC §6, §12).
--
-- Ending a send is a new act in the send's log of acts, beside Resolve: `end`, with who ended it
-- and when, and the resolution it chose for recipients whose fate was unknown, when it settled
-- any. A Resolve always chooses one, so its resolution stays required; an End may have had none
-- to settle. A STRICT table's CHECK can't be altered, so the table is rebuilt, every row and
-- column carried over, with the index 0014 made.
--
-- What can't be recovered: nothing. Every row is copied as it was.

CREATE TABLE send_acts_next (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id    TEXT NOT NULL REFERENCES sends (id),
  act        TEXT NOT NULL CHECK (act IN ('schedule', 'send_now', 'reschedule', 'cancel', 'resolve', 'end')),
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL
             CHECK (json_valid(actor) AND json_extract(actor, '$.kind') IN ('human', 'service')),
  fire_at    INTEGER CHECK ((fire_at IS NOT NULL) = (act IN ('schedule', 'send_now', 'reschedule'))),
  resolution TEXT
             CHECK ((resolution IS NULL OR act IN ('resolve', 'end'))
                    AND (resolution IS NOT NULL OR act <> 'resolve')
                    AND (resolution IS NULL OR resolution IN ('unsent', 'accepted')))
) STRICT;

INSERT INTO send_acts_next (id, send_id, act, at, actor, fire_at, resolution)
  SELECT id, send_id, act, at, actor, fire_at, resolution FROM send_acts;

DROP TABLE send_acts;
ALTER TABLE send_acts_next RENAME TO send_acts;
CREATE INDEX idx_send_acts_send ON send_acts (send_id, id);
