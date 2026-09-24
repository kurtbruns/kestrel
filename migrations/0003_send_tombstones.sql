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
-- The floor is carried forward as one tombstone holding its number, so the sequence never
-- falls back below a cursor a client already holds (a later write would otherwise take a
-- number that cursor claims to be past, and the change would be skipped). Its id names no
-- send, so a client told it was removed has nothing to drop.
--
-- `send_rev_floor` itself stays, unread by the code this migration ships with, because
-- the upgrade runs migrations before it deploys: the Worker still serving in between reads
-- the floor on every write to a send, and would fail every one without it. A later
-- migration drops it once no deployed code reads it.

CREATE TABLE send_tombstones (
  id  TEXT PRIMARY KEY,     -- the removed send's id
  rev INTEGER NOT NULL      -- where the removal sits in the change sequence
) STRICT;

-- What was removed after a cursor is a range read on it, as for sends.
CREATE INDEX idx_send_tombstones_rev ON send_tombstones (rev);

INSERT INTO send_tombstones (id, rev)
  SELECT 'send-rev-floor', value FROM send_rev_floor WHERE id = 1 AND value > 0;
