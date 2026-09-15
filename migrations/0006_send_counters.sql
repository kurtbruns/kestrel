-- 0006_send_counters — denormalized progress counters on the `sends` row (SPEC §8).
--
-- Progress used to be a GROUP BY/COUNT over the whole delivery set on every read —
-- fine at hundreds of rows, but every poll of an in-flight 100k send aggregated the
-- full audience. These eight columns make `GET /sends/:id/progress` a single-row read.
-- `deliveries` stays the source of truth; the counters are a rebuildable cache,
-- maintained in the SAME transactions as each recipient transition (src/db/sends.ts)
-- and the webhook ingest (src/services/webhook_events.ts), and recomputed from the
-- aggregate whenever a send completes.
--
-- The eight buckets are mutually exclusive and sum to the materialized audience,
-- matching `deliveryOutcomes` exactly: the webhook `event` wins over the send-loop
-- `status` (a delivered/bounced/complained row counts in its event bucket, never in
-- `accepted`), and `in_flight` is split into `c_pending` (queued) + `c_in_flight`
-- (dispatched, awaiting a provider response).

ALTER TABLE sends ADD COLUMN c_pending    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_in_flight  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_accepted   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_delivered  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_bounced    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_complained INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_skipped    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN c_failed     INTEGER NOT NULL DEFAULT 0;

-- Backfill from `deliveries` (the source of truth) so existing and seeded sends carry
-- correct counters immediately. Same bucketing as `deliveryOutcomes`: event first,
-- then the send-loop status for rows no event has landed on yet.
UPDATE sends SET
  c_pending    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'pending'),
  c_in_flight  = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'dispatched'),
  c_accepted   = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'accepted'),
  c_delivered  = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'delivered'),
  c_bounced    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'bounced'),
  c_complained = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event = 'complained'),
  c_skipped    = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'skipped'),
  c_failed     = (SELECT COUNT(*) FROM deliveries d WHERE d.send_id = sends.id AND d.event IS NULL AND d.status = 'failed');
