-- 0002_delivery_events — post-send provider events (M9).
--
-- SES delivery notifications arrive later, out of band, via SNS
-- (delivered / bounced / complained). They are recorded SEPARATELY from the
-- send-loop lifecycle `status` (whose CHECK constraint stays fixed at
-- pending -> dispatched -> accepted | failed | skipped), so the send state
-- machine and its idempotent-resume backbone are untouched. A hard bounce or a
-- complaint also adds a suppression — see src/services/webhook_events.ts.
--
-- Matching is by the SES MessageId stored on the delivery row as `provider_id`,
-- so index it for the webhook lookup.

ALTER TABLE deliveries ADD COLUMN event        TEXT;    -- delivered | bounced | complained
ALTER TABLE deliveries ADD COLUMN event_detail TEXT;    -- bounce subtype / complaint feedback / diagnostic
ALTER TABLE deliveries ADD COLUMN event_at     INTEGER; -- when the event was applied (epoch ms)

CREATE INDEX idx_deliveries_provider ON deliveries (provider_id);
