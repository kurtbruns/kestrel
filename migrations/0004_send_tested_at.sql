-- 0004_send_tested_at: when a scheduled send's frozen copy was last tested (SPEC §8).
--
-- A re-make (a template or identity change, SPEC §6) resets the sign-off, so the last
-- approving test should be of the re-made copy. With when the send was last tested beside
-- when it was last re-made (`remade_at`), the app can say which sends' last test predates
-- a re-make, for the editor and Claude alike, rather than each client guessing.
-- Null until a test of the frozen copy is sent while the send is scheduled.

ALTER TABLE sends ADD COLUMN tested_at INTEGER;
