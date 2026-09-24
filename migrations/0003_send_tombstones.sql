-- 0003_send_tombstones: a removed send is recorded in the change sequence (SPEC §8: every
-- change to a send takes its place in one order, removing a send included).
--
-- A send deleted with its post leaves a tombstone: its id and the number the removal took
-- in the sequence, written in the same batch as the delete. A client asking what changed
-- since a cursor below that number is told the send is gone, rather than keeping a row
-- for a send that no longer exists. The sequence is now the largest `rev` any send or
-- tombstone holds, so it still never falls back when the send holding the largest number
-- goes, and `send_rev_floor`, which only kept that from happening, is no longer needed.
--
-- The floor is dropped without carrying it forward. A local database whose floor stood
-- above every remaining send's `rev` reads a lower sequence afterward, and a client still
-- holding a cursor from before is told its cursor is ahead of the database and re-reads,
-- the same answer it gets after a local reset or a restore.

CREATE TABLE send_tombstones (
  id  TEXT PRIMARY KEY,     -- the removed send's id
  rev INTEGER NOT NULL      -- where the removal sits in the change sequence
) STRICT;

-- What was removed after a cursor is a range read on it, as for sends.
CREATE INDEX idx_send_tombstones_rev ON send_tombstones (rev);

DROP TABLE send_rev_floor;
