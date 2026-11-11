-- 0024_sending_receipts: whether the provider's reports reach the app (SPEC §13).
--
-- Bounces and complaints reach the app only when every link of the return path holds, and
-- nothing failed when one didn't. So the `sending` row, which every answer the provider gives an
-- email already writes, now also keeps what the webhook has heard:
--
--   - `last_receipt_at`: when the webhook last took a verified report (a delivery, a bounce, or a
--     complaint), about any email, a test or a confirmation included.
--   - `waiting_since`: when the provider took the first email after that report, kept by the same
--     write that records an email taken and cleared by the next report. An hour past it with no
--     report is the `receipts_not_arriving` warning. The last email taken can't serve, since an
--     instance that sends one every half hour would never be an hour past it.
--   - `refused_topic`, `refused_topic_expected`, `refused_topic_at`: the topic of the last report
--     SNS signed that the webhook refused for naming a topic other than `SNS_TOPIC_ARN`, the one
--     it names, and when, so the warning can say which two disagree.
--
-- An instance that has been receiving reports starts with the newest receipt on a delivery row,
-- so the upgrade shows it no warning. What can't be recovered: a report about a test or a
-- confirmation, which no row kept, so an instance with none on a delivery row starts empty and
-- warns only once an email the provider takes after the upgrade goes an hour with no report.

ALTER TABLE sending ADD COLUMN last_receipt_at INTEGER;
ALTER TABLE sending ADD COLUMN waiting_since INTEGER;
ALTER TABLE sending ADD COLUMN refused_topic TEXT;
ALTER TABLE sending ADD COLUMN refused_topic_expected TEXT;
ALTER TABLE sending ADD COLUMN refused_topic_at INTEGER;

UPDATE sending SET last_receipt_at = (SELECT MAX(event_at) FROM deliveries WHERE event IS NOT NULL);
