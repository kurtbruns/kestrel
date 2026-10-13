-- 0006_deliveries_fewer_indexes: drop two indexes on deliveries that no query uses, so each
-- recipient of a send writes fewer index entries.
--
-- Every write to a delivery row also writes each index entry it moves, and on the Workers
-- Free plan D1 refuses every query once a day's written rows are spent, so an index no query
-- reads costs a send's reach for nothing.
--
-- idx_deliveries_in_flight indexed `updated_at` over the rows in flight, for a sweep that
-- looked for in-flight rows gone stale. No query reads in-flight rows by time now: how long
-- a send has run is read from the send, and a stuck send from its counters.
--
-- idx_deliveries_dispatch_key indexed the dispatch key alone. Every query that reads by key
-- also names the send and a status, and reads through (send_id, status); none looks a row
-- up by key alone.
--
-- Dropping an index writes no rows, so this costs nothing to apply at any size.

DROP INDEX IF EXISTS idx_deliveries_in_flight;
DROP INDEX IF EXISTS idx_deliveries_dispatch_key;
