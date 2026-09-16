-- Per-send frozen soft/hard bounce fact.
--
-- The record view splits a HARD bounce (permanent; suppressed the address) from a SOFT
-- one (transient; counted, never suppressed). That split must be a fact of THIS send,
-- recorded when the event landed — a frozen part of the record (I3, SPEC §8) — not read
-- back from the global `suppressions` table, which is keyed by address (cross-send) and
-- can be cleared, so deriving the label from it lets a "frozen" record drift after the
-- fact. The webhook already knows `hard` at ingest; persist it here on the delivery row.
--
-- No backfill: there are no deployed databases, and the dev/test databases are recreated
-- from these migrations each run (the seed writes `bounce_kind` directly), so there is no
-- pre-existing bounced row to reclassify.
ALTER TABLE deliveries ADD COLUMN bounce_kind TEXT
  CHECK (bounce_kind IN ('hard', 'soft'));
