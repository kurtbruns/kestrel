-- 0004_keyed_pending_to_resolve: a batch an earlier release left waiting to be re-sent
-- under its key now waits for Resolve (SPEC §12).
--
-- Releases before 1.8.0 could send a batch whose answer never came, or never proved it
-- was refused, back to the queue with its dispatch key kept, so the next run would re-send
-- it under that key and an idempotent provider (Resend) would deduplicate it. This release
-- re-sends nothing: no provider it supports dedupes a repeat, so a batch of unknown fate
-- waits for the publisher's Resolve. Left as it was, such a row would never be picked up
-- (only rows with no key are handed off) and the send would never read as wedged, since
-- it still counts as pending: it would stay open and silent.
--
-- So every `pending` row of a send still sending that carries a key moves to `dispatched`, the in-flight
-- state Resolve settles, and its send's pending and in-flight counters move with it. A
-- database that never ran such a send changes nothing.

UPDATE sends SET
  c_pending = c_pending - (SELECT COUNT(*) FROM deliveries d
    WHERE d.send_id = sends.id AND d.status = 'pending' AND d.dispatch_key IS NOT NULL AND d.event IS NULL),
  c_in_flight = c_in_flight + (SELECT COUNT(*) FROM deliveries d
    WHERE d.send_id = sends.id AND d.status = 'pending' AND d.dispatch_key IS NOT NULL AND d.event IS NULL),
  rev = (MAX(COALESCE((SELECT MAX(rev) FROM sends), 0), COALESCE((SELECT MAX(rev) FROM send_tombstones), 0)) + 1)
WHERE status = 'sending'
  AND id IN (SELECT send_id FROM deliveries WHERE status = 'pending' AND dispatch_key IS NOT NULL);

UPDATE deliveries SET status = 'dispatched'
WHERE status = 'pending' AND dispatch_key IS NOT NULL
  AND send_id IN (SELECT id FROM sends WHERE status = 'sending');
