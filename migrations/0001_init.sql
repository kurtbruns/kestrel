-- 0001_init — Kestrel schema (spec §9).
-- Timestamps are unix epoch milliseconds (INTEGER). Text ids are app-generated
-- (UUID / random tokens). FK declarations document intent; the app also enforces
-- cascades in code since D1 does not enable foreign_keys by default.

-- The only content tables. Everything else is audience and record.
CREATE TABLE posts (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  subject          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'scheduled', 'sent')),
  current_revision TEXT,                       -- -> post_revisions.id (nullable until first save)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_posts_status ON posts (status);

CREATE TABLE post_revisions (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts (id),
  markdown   TEXT NOT NULL DEFAULT '',
  metadata   TEXT NOT NULL DEFAULT '{}',       -- JSON: {subject, slug}
  author     TEXT,                             -- principal that saved this revision
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revisions_post ON post_revisions (post_id, created_at);

CREATE TABLE images (
  id           TEXT PRIMARY KEY,
  post_id      TEXT NOT NULL REFERENCES posts (id),
  filename     TEXT NOT NULL,                  -- referenced by name in the Markdown
  storage_key  TEXT NOT NULL,                  -- R2 object key
  content_type TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (post_id, filename)
);
CREATE INDEX idx_images_post ON images (post_id);

CREATE TABLE subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  token           TEXT NOT NULL UNIQUE,        -- unguessable; confirm + unsubscribe
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  unsubscribed_at INTEGER
);
CREATE INDEX idx_subscribers_status ON subscribers (status);

CREATE TABLE suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,                    -- 'bounce' | 'complaint' | 'manual'
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- Created at schedule time; holds the frozen render (I3). status:
-- scheduled -> sending -> sent | canceled | failed. locked_until is the send-loop lease.
CREATE TABLE sends (
  id              TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL REFERENCES posts (id),
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'sending', 'sent', 'canceled', 'failed')),
  fire_at         INTEGER NOT NULL,
  rendered_html   TEXT NOT NULL,               -- frozen; carries %%UNSUBSCRIBE_URL%% sentinel
  rendered_text   TEXT NOT NULL,
  subject         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,  -- display snapshot only
  locked_until    INTEGER,                     -- send-loop lease (overlap guard)
  scheduled_at    INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
);
CREATE INDEX idx_sends_status_fire ON sends (status, fire_at);
CREATE INDEX idx_sends_post ON sends (post_id);

-- One row per recipient per send. UNIQUE(send_id, email) is the backbone of
-- idempotent resume (I4). status: pending -> dispatched -> accepted | failed | skipped.
--
-- The event columns hold out-of-band provider notifications (delivered / bounced /
-- complained), which arrive later via the delivery webhook. They are recorded
-- SEPARATELY from the send-loop `status` (whose CHECK stays fixed), so the send
-- state machine and its idempotent-resume backbone are untouched. A hard bounce or
-- a complaint also adds a suppression — see src/services/webhook_events.ts. Matching
-- is by the provider message id stored as `provider_id`, so it is indexed.
CREATE TABLE deliveries (
  id           TEXT PRIMARY KEY,
  send_id      TEXT NOT NULL REFERENCES sends (id),
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'dispatched', 'accepted', 'failed', 'skipped')),
  provider_id  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  event        TEXT,                           -- delivered | bounced | complained
  event_detail TEXT,                           -- bounce subtype / complaint feedback / diagnostic
  event_at     INTEGER,                        -- when the event was applied (epoch ms)
  UNIQUE (send_id, email)
);
CREATE INDEX idx_deliveries_send_status ON deliveries (send_id, status);
CREATE INDEX idx_deliveries_provider ON deliveries (provider_id);
