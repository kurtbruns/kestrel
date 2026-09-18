-- 0008_unsent_outcome — rename the recipient delivery outcome `failed` -> `unsent`.
--
-- "Never accepted by the provider" (a permanent rejection at dispatch, retries
-- exhausted, or an operator "assume not sent") is the send-side failure outcome. It is
-- renamed from `failed` to `unsent` so it no longer shares a word with the Failures
-- group or with the whole-send `sends.status = 'failed'`, which is a DIFFERENT level (a
-- whole send failing) and is left unchanged here.
--
-- `deliveries.status` is CHECK-constrained, and SQLite can only change a CHECK by
-- rebuilding the table, so this recreates `deliveries` with the new status set and maps
-- any existing row. Per 0007 there are no deployed databases and the dev/test databases
-- are rebuilt from these migrations each run, so the table is empty at migration time and
-- the CASE below is a safety net rather than a real backfill.

CREATE TABLE deliveries_new (
  id           TEXT PRIMARY KEY,
  send_id      TEXT NOT NULL REFERENCES sends (id),
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'dispatched', 'accepted', 'unsent', 'skipped')),
  provider_id  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  event        TEXT,
  event_detail TEXT,
  event_at     INTEGER,
  bounce_kind  TEXT CHECK (bounce_kind IN ('hard', 'soft')),
  UNIQUE (send_id, email)
);

INSERT INTO deliveries_new
  (id, send_id, email, status, provider_id, error, attempts, updated_at, event, event_detail, event_at, bounce_kind)
SELECT
  id, send_id, email,
  CASE status WHEN 'failed' THEN 'unsent' ELSE status END,
  provider_id, error, attempts, updated_at, event, event_detail, event_at, bounce_kind
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;

CREATE INDEX idx_deliveries_send_status ON deliveries (send_id, status);
CREATE INDEX idx_deliveries_provider ON deliveries (provider_id);

-- Rename the denormalized counter (migration 0006) to match the outcome.
ALTER TABLE sends RENAME COLUMN c_failed TO c_unsent;
