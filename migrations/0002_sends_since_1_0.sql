-- 0002_sends_since_1_0: what a send records beyond the 1.0.0 baseline (SPEC §8).
--
-- A change sequence over sends, so what a page shows keeps up with a change made anywhere,
-- by either client. Every write that changes what a reader can see of a send gives it a
-- `rev` above every change before it, across all sends, so a client that holds the
-- sequence value it last read can ask for every send that changed after it and miss none.
-- The app stamps `rev` in each write (src/db/sends.ts, NEXT_REV).
--
-- A removed send takes its place in that sequence too. A send deleted with its post leaves
-- a tombstone: its id and the number the removal took, written in the same batch as the
-- delete. A client asking what changed since a cursor below that number is told the send
-- is gone, rather than keeping a row for a send that no longer exists. The sequence is the
-- largest `rev` any send or tombstone holds, so it never falls back when the send holding
-- the largest number goes.
--
-- When a scheduled send's frozen copy was last tested (`tested_at`). A re-make (a template
-- or identity change, SPEC §6) resets the sign-off, so the last approving test should be
-- of the re-made copy. With when the send was last tested beside when it was last re-made
-- (`remade_at`), the app can say which sends' last test predates a re-make, for the editor
-- and Claude alike, rather than each client guessing.

ALTER TABLE sends ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- Each existing send takes its rowid, distinct and positive.
UPDATE sends SET rev = rowid;

-- The sequence is MAX(rev), and what changed after a cursor is a range read on it.
CREATE INDEX idx_sends_rev ON sends (rev);

CREATE TABLE send_tombstones (
  id  TEXT PRIMARY KEY,     -- the removed send's id
  rev INTEGER NOT NULL      -- where the removal sits in the change sequence
) STRICT;

-- What was removed after a cursor is a range read on it, as for sends.
CREATE INDEX idx_send_tombstones_rev ON send_tombstones (rev);

-- Null until a test of the frozen copy is sent while the send is scheduled.
ALTER TABLE sends ADD COLUMN tested_at INTEGER;
