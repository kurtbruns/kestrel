-- 0002_send_rev — a change sequence over sends (SPEC §8: what a page shows keeps up with
-- a change made anywhere, by either client).
--
-- Every write that changes what a reader can see of a send stamps the send's `rev` with
-- the next value of ONE app-wide sequence, not a per-send counter: a client that holds the
-- sequence value it last read can then ask for every send that changed after it, across
-- sends, and miss none, whether the change was a cancel, a move, a re-make, a new
-- schedule, a counter move from the send loop, or a webhook receipt landing a day later.
--
-- The stamp is a trigger rather than a line in each update helper, so no write path can
-- forget it, today's or a future one's. It fires only when a visible column actually
-- changed (a compare-and-swap that matched no row, or a SET that wrote the same value,
-- stamps nothing). The one column left out is `locked_until`: a running send renews its
-- lease every batch, and a renewal changes nothing a reader sees. Taking or releasing the
-- lease does change `lease_token`, and is stamped, because whether a lease is held is what
-- tells a wedged send (given up, awaiting Resolve) from one finishing its last batch.
-- `test/schema.spec.ts` fails if a column is added to `sends` without joining the list.
--
-- D1 counts the trigger's own writes in a statement's `meta.changes`, so a write to `sends`
-- reports more rows than it matched. Read it as zero or not zero (the compare-and-swaps
-- already do), never as a count.
--
-- D1's remote migration splitter recognizes a trigger body only by an uppercase BEGIN on
-- LF line endings, so both are kept here (and checked by the same spec); local and test
-- runs accept either, which is why the check is a spec rather than a deploy surprise.

-- The sequence: one row, only ever incremented.
CREATE TABLE send_rev_seq (
  id    INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton
  value INTEGER NOT NULL
) STRICT;

ALTER TABLE sends ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- Backfill before the triggers exist, so this write stamps nothing: each existing send
-- takes its rowid, distinct and positive, and the sequence starts past the largest.
UPDATE sends SET rev = rowid;
INSERT INTO send_rev_seq (id, value) SELECT 1, COALESCE(MAX(rev), 0) FROM sends;

CREATE TRIGGER sends_rev_insert AFTER INSERT ON sends
BEGIN
  UPDATE send_rev_seq SET value = value + 1 WHERE id = 1;
  UPDATE sends SET rev = (SELECT value FROM send_rev_seq WHERE id = 1) WHERE id = NEW.id;
END;

-- The inner UPDATE changes only `rev`, which is not in the WHEN list, so it never re-fires
-- this trigger whether or not recursive triggers are on.
CREATE TRIGGER sends_rev_update AFTER UPDATE ON sends
WHEN NEW.id IS NOT OLD.id
  OR NEW.post_id IS NOT OLD.post_id
  OR NEW.status IS NOT OLD.status
  OR NEW.fire_at IS NOT OLD.fire_at
  OR NEW.rendered_html IS NOT OLD.rendered_html
  OR NEW.rendered_text IS NOT OLD.rendered_text
  OR NEW.subject IS NOT OLD.subject
  OR NEW.recipient_count IS NOT OLD.recipient_count
  OR NEW.audience_resolved_at IS NOT OLD.audience_resolved_at
  OR NEW.lease_token IS NOT OLD.lease_token
  OR NEW.scheduled_at IS NOT OLD.scheduled_at
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.completed_at IS NOT OLD.completed_at
  OR NEW.remade_at IS NOT OLD.remade_at
  OR NEW.halt_reason IS NOT OLD.halt_reason
  OR NEW.halt_cause IS NOT OLD.halt_cause
  OR NEW.halt_error IS NOT OLD.halt_error
  OR NEW.halted_at IS NOT OLD.halted_at
  OR NEW.halt_retries IS NOT OLD.halt_retries
  OR NEW.halt_retry_at IS NOT OLD.halt_retry_at
  OR NEW.c_pending IS NOT OLD.c_pending
  OR NEW.c_in_flight IS NOT OLD.c_in_flight
  OR NEW.c_accepted IS NOT OLD.c_accepted
  OR NEW.c_delivered IS NOT OLD.c_delivered
  OR NEW.c_bounced IS NOT OLD.c_bounced
  OR NEW.c_complained IS NOT OLD.c_complained
  OR NEW.c_skipped IS NOT OLD.c_skipped
  OR NEW.c_unsent IS NOT OLD.c_unsent
BEGIN
  UPDATE send_rev_seq SET value = value + 1 WHERE id = 1;
  UPDATE sends SET rev = (SELECT value FROM send_rev_seq WHERE id = 1) WHERE id = NEW.id;
END;

-- What changed after a cursor is a range read on `rev`. Kept last in the file, so no
-- trigger is the migration's final statement (the remote splitter has tripped on that).
CREATE INDEX idx_sends_rev ON sends (rev);
