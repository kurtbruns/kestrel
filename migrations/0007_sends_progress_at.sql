-- 0007_sends_progress_at: when a send last made progress (SPEC §12).
--
-- A send is in flight too long when it has handed off no one for a while and nothing else
-- explains why, not when it has been sending a while: a large send on a slow provider rate
-- goes out for hours and is fine. `progress_at` is when the provider last answered for any
-- of the send's recipients, so the app can tell a send that is moving from one that has
-- stopped. Null until the first answer, when the send's start stands in for it, so a send
-- already in flight when this runs reads as it did (src/db/sends.ts, SEND_IDLE_SINCE).
--
-- Adding a nullable column writes no rows, so this costs nothing to apply at any size.

ALTER TABLE sends ADD COLUMN progress_at INTEGER;
