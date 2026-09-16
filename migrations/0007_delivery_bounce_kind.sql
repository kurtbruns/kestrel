-- Per-send frozen soft/hard bounce fact.
--
-- The record view splits a HARD bounce (permanent; suppressed the address) from a SOFT
-- one (transient; counted, never suppressed). That split must be a fact of THIS send,
-- recorded when the event landed — a frozen part of the record (I3, SPEC §8) — not read
-- back from the global `suppressions` table, which is keyed by address (cross-send) and
-- can be cleared, so deriving the label from it lets a "frozen" record drift after the
-- fact. The webhook already knows `hard` at ingest; persist it here on the delivery row.
ALTER TABLE deliveries ADD COLUMN bounce_kind TEXT
  CHECK (bounce_kind IN ('hard', 'soft'));

-- Backfill existing bounced rows from the diagnostic text the ingest already wrote
-- ("hard bounce" / "soft bounce" when the provider supplied no detail of its own). Rows
-- whose detail is provider-specific stay NULL (kind unknown) and render as a plain
-- "Bounce" — the coarse outcome is unaffected, only the soft/hard qualifier.
UPDATE deliveries
   SET bounce_kind = CASE
         WHEN event_detail LIKE 'hard%' THEN 'hard'
         WHEN event_detail LIKE 'soft%' THEN 'soft'
       END
 WHERE event = 'bounced';
