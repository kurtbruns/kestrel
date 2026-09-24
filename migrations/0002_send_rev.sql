-- 0002_send_rev — a change sequence over sends (SPEC §8: what a page shows keeps up with
-- a change made anywhere, by either client).
--
-- Every write that changes what a reader can see of a send gives it a `rev` above every
-- change before it, across all sends, so a client that holds the sequence value it last
-- read can ask for every send that changed after it and miss none. The sequence is the
-- largest `rev` any send holds; `send_rev_floor` keeps it from falling back when the send
-- holding it is deleted. The app stamps `rev` in each write (src/db/sends.ts, NEXT_REV).

-- The floor: raised to the sequence just before sends are deleted, never lowered.
CREATE TABLE send_rev_floor (
  id    INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton
  value INTEGER NOT NULL
) STRICT;

ALTER TABLE sends ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- Each existing send takes its rowid, distinct and positive.
UPDATE sends SET rev = rowid;
INSERT INTO send_rev_floor (id, value) VALUES (1, 0);

-- The sequence is MAX(rev), and what changed after a cursor is a range read on it.
CREATE INDEX idx_sends_rev ON sends (rev);
