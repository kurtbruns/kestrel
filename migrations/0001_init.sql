-- 0001_init — the Kestrel schema (SPEC §2: the six nouns, plus settings).
--
-- This is the baseline. Until 1.0.0, the self-host release, it is edited in place: no
-- database anyone would mind rebuilding has run it, so there is nothing to migrate. But
-- wrangler tracks applied migrations by filename, so after a change here every existing
-- database is rebuilt (delete .wrangler/state/v3/d1 and run `migrate:local`). It freezes
-- at 1.0.0, or earlier the day a database with data worth keeping has run it; from then
-- on migrations are append-only: never edit this file, add the next one.
--
-- Timestamps are unix epoch milliseconds (INTEGER). Text ids are app-generated
-- (UUID / random tokens). D1 enforces the FK declarations (foreign_keys is on) but
-- none declares an ON DELETE action, so the app deletes children before parents in code.
--
-- Every table is STRICT, so a value of the wrong type is refused rather than stored as
-- whatever it arrived as. Every email column holds the address lowercased (the app
-- normalizes before it writes, `shared/email.ts`) and says so with a CHECK, because
-- consent and suppression are matched by exact comparison: a mixed-case copy of an
-- address would silently escape its own unsubscribe or suppression (I1, I2).

-- ---------------------------------------------------------------- content

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
) STRICT;
CREATE INDEX idx_posts_status ON posts (status);
CREATE INDEX idx_posts_updated ON posts (updated_at);   -- the post list's default sort

CREATE TABLE post_revisions (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts (id),
  markdown   TEXT NOT NULL DEFAULT '',
  metadata   TEXT NOT NULL DEFAULT '{}',       -- JSON: {subject, slug}
  author     TEXT,                             -- principal that saved this revision
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_revisions_post ON post_revisions (post_id, created_at);

CREATE TABLE images (
  id           TEXT PRIMARY KEY,
  post_id      TEXT NOT NULL REFERENCES posts (id),
  filename     TEXT NOT NULL,                  -- referenced by name in the Markdown
  storage_key  TEXT NOT NULL,                  -- R2 object key
  content_type TEXT NOT NULL,
  width        INTEGER CHECK (width > 0),     -- null when the format's size wasn't read
  height       INTEGER CHECK (height > 0),
  created_at   INTEGER NOT NULL,
  UNIQUE (post_id, filename)                    -- also serves lookups by post
) STRICT;

-- ---------------------------------------------------------------- audience

-- Two tokens, two jobs (SPEC §7). The confirm token is one-shot double opt-in and is
-- rotated when a pending/unsubscribed address re-subscribes; its single-use property
-- comes from confirm() gating on status = 'pending', not from clearing it. It is only
-- good for a fixed window after confirm_sent_at, when the confirmation carrying it went
-- out. confirm_attempt_at is the per-address cooldown clock: the last time a confirmation
-- was attempted, stamped before the send so two racing requests can't both send. The
-- unsubscribe token is durable and NEVER rotated, not even across an unsubscribe →
-- resubscribe cycle, because it is embedded in the one-click unsubscribe link of every
-- post already delivered: a returning subscriber can still leave from mail that has
-- been in their inbox since before they last left (I2). One token doing both jobs
-- would go dead in delivered mail the moment it rotated.
CREATE TABLE subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token   TEXT UNIQUE,                 -- one-shot double opt-in; rotated on re-arm
  confirm_sent_at INTEGER,                     -- when confirm_token was sent; the link's age
  confirm_attempt_at INTEGER,                  -- last confirmation attempted; the resend cooldown
  unsub_token     TEXT NOT NULL UNIQUE,        -- durable; embedded in delivered mail; never rotated
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  unsubscribed_at INTEGER
) STRICT;
CREATE INDEX idx_subscribers_status ON subscribers (status);
CREATE INDEX idx_subscribers_created ON subscribers (created_at);   -- the roster's default sort

-- Deliverability, not consent (SPEC §7): an address that hard-bounced or complained is
-- excluded from every send whatever its consent state, until cleared deliberately.
-- `erased` is the do-not-contact marker an erasure leaves (SPEC §7), the only trace of
-- the address kept, which the person's own resubscribe lifts. The import reasons record a
-- bounce or complaint a list brought with it from its previous service, kept apart from
-- the ones this instance saw so the record says where each came from.
CREATE TABLE suppressions (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  reason     TEXT NOT NULL
               CHECK (reason IN ('bounce', 'complaint', 'manual', 'erased',
                                 'import_bounce', 'import_complaint')),
  detail     TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- preferences

-- App-level runtime settings (SPEC §9): a single-row JSON blob so a new preference is
-- a code change, not a migration; the app owns the typed shape (src/db/settings.ts).
-- Holds ONLY runtime preferences — never secrets or deploy-time infrastructure, which
-- stay in env/secrets. Edited via the authed /api/settings.
CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  data       TEXT NOT NULL DEFAULT '{}',          -- JSON: the AppSettings shape
  updated_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- the record

-- A send is created at schedule time and holds the frozen render (I3). Its status is
-- scheduled -> sending -> sent, or canceled during the review window; a send never
-- fails — it keeps retrying, and the one ambiguous case waits for a human (SPEC §12).
-- locked_until is the send-loop lease (overlap guard), and lease_token names the run
-- that holds it: every lease write and every delivery hand-off is conditioned on the
-- token, so a run whose lease expired under it can neither release a successor's lease
-- nor hand off rows the successor now owns.
--
-- A scheduled send's frozen render is made again in place when the template or the
-- identity changes (SPEC §6, §9): the rendered columns are rewritten under a
-- compare-and-swap on status = 'scheduled', so a send that has fired is never touched,
-- and remade_at records when that last happened (the sign-off reset a publisher sees).
--
-- The c_* columns are denormalized progress counters (SPEC §8) so a poll of an
-- in-flight send is a single-row read instead of an aggregate over its audience.
-- `deliveries` stays the source of truth; the counters are a rebuildable cache,
-- maintained in the SAME transactions as each recipient transition and the webhook
-- ingest, and recomputed from the aggregate whenever a send completes. The eight
-- buckets are mutually exclusive and sum to the materialized audience: the webhook
-- `event` wins over the send-loop `status` (a delivered/bounced/complained row counts
-- in its event bucket, never in `accepted`), and in-flight work is split into
-- `c_pending` (queued) + `c_in_flight` (dispatched, awaiting a provider response).
CREATE TABLE sends (
  id              TEXT PRIMARY KEY,
  post_id         TEXT NOT NULL REFERENCES posts (id),
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'sending', 'sent', 'canceled')),
  fire_at         INTEGER NOT NULL,
  rendered_html   TEXT NOT NULL,               -- frozen; carries %%UNSUBSCRIBE_URL%% sentinel
  rendered_text   TEXT NOT NULL,
  subject         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,  -- schedule-time snapshot for display until
                                               -- the send fires, then the audience at fire
  audience_resolved_at INTEGER,                -- when the first run fixed the audience into
                                               -- deliveries; never resolved again (SPEC §6)
  locked_until    INTEGER,                     -- send-loop lease (overlap guard)
  lease_token     TEXT,                        -- the run holding the lease
  scheduled_at    INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  remade_at       INTEGER,                     -- when a template or identity change last
                                               -- re-made the frozen render while scheduled
  halt_reason     TEXT                         -- the provider refused the last batch as a
                    CHECK (halt_reason IN ('unavailable', 'account')),  -- whole; null once
                                               -- a batch is answered
  halt_cause      TEXT,                        -- what the refusal is about (a key, the
                                               -- sender, a quota, ...), for the advice shown
  halt_error      TEXT,                        -- the provider's words for that refusal
  halted_at       INTEGER,                     -- when refusals of this reason began
  halt_retries    INTEGER NOT NULL DEFAULT 0,  -- halted runs in a row for that reason,
                                               -- which picks the next retry's delay
  halt_retry_at   INTEGER,                     -- the sweep leaves a halted send alone
                                               -- until then; null once a batch is answered
  c_pending       INTEGER NOT NULL DEFAULT 0,
  c_in_flight     INTEGER NOT NULL DEFAULT 0,
  c_accepted      INTEGER NOT NULL DEFAULT 0,
  c_delivered     INTEGER NOT NULL DEFAULT 0,
  c_bounced       INTEGER NOT NULL DEFAULT 0,
  c_complained    INTEGER NOT NULL DEFAULT 0,
  c_skipped       INTEGER NOT NULL DEFAULT 0,
  c_unsent        INTEGER NOT NULL DEFAULT 0
) STRICT;
-- (status, fire_at) serves the sweep and the status-filtered list sort; the unfiltered
-- fire_at sort is a small scan accepted at newsletter scale rather than a third index.
CREATE INDEX idx_sends_status_fire ON sends (status, fire_at);
CREATE INDEX idx_sends_post ON sends (post_id);

-- "One active send per post" is a database guarantee, not a check-then-insert (I4, I6).
-- Two concurrent schedule requests across Worker isolates could both pass an app-side
-- check and both insert; a PARTIAL unique index closes that: uniqueness on post_id, but
-- only over the active statuses, so a completed or canceled send never blocks a later
-- re-schedule. The state machine only ever transitions a row in place, so it never
-- creates a second active row and the index holds across a send's life.
CREATE UNIQUE INDEX idx_sends_one_active_per_post
  ON sends (post_id)
  WHERE status IN ('scheduled', 'sending');

-- One row per recipient per send. UNIQUE(send_id, email) is the backbone of idempotent
-- resume (I4). The send-loop status is pending -> dispatched -> accepted | unsent |
-- skipped: `unsent` is the send-side failure (never accepted by the provider — a
-- permanent rejection, retries exhausted, or an "assume not sent" resolution), and
-- `skipped` is a deliberate non-send (consent or suppression re-checked at hand-off).
--
-- The event columns hold the provider's out-of-band notifications (delivered / bounced /
-- complained), which arrive later via the webhook. They are recorded SEPARATELY from the
-- send-loop `status`, so the state machine and its idempotent-resume backbone are
-- untouched. Matching is by the provider message id stored as `provider_id`, so it is
-- indexed. A hard bounce or a complaint also adds a suppression.
--
-- `bounce_kind` freezes the hard/soft split as a fact of THIS send, recorded when the
-- event landed (I3, SPEC §8), rather than derived later from the global, clearable
-- `suppressions` table — which would let a "frozen" record drift after the fact.
--
-- `dispatch_key` is the idempotency key a batch of recipients was handed off under. It
-- is set when the rows move to `dispatched` and kept while their fate is unknown (still
-- `dispatched`, or back in `pending` after a request that got no answer), so a resumed
-- send re-sends exactly that batch under exactly that key and the provider dedupes it
-- (I4). Recording the outcome clears it, which keeps its partial index small.
--
-- This is the table that grows largest, one row per recipient per send, so its key is the
-- rowid itself (`INTEGER PRIMARY KEY`): no second index for the key, and pending rows
-- work in the order they were inserted. The id never leaves the database; the record and
-- the API name a delivery by its send and address. The address may also be an erasure's
-- placeholder, `erased:` and lowercase hex (SPEC §7), which keeps each past record summing
-- to its audience once the person is gone.
CREATE TABLE deliveries (
  id           INTEGER PRIMARY KEY,
  send_id      TEXT NOT NULL REFERENCES sends (id),
  email        TEXT NOT NULL CHECK (email = lower(email)),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'dispatched', 'accepted', 'unsent', 'skipped')),
  provider_id  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  event        TEXT CHECK (event IN ('delivered', 'bounced', 'complained')),
  event_detail TEXT,                           -- bounce subtype / complaint feedback / diagnostic
  event_at     INTEGER,                        -- when the event was applied (epoch ms)
  bounce_kind  TEXT CHECK (bounce_kind IN ('hard', 'soft')),
  dispatch_key TEXT,                           -- the hand-off's idempotency key, while unanswered
  keyed_at     INTEGER,                        -- when that key was first sent, for the
                                               -- provider's idempotency window
  UNIQUE (send_id, email)
) STRICT;
CREATE INDEX idx_deliveries_send_status ON deliveries (send_id, status);
-- A provider message id names one delivery, so the webhook's match is exact; enforced
-- here rather than assumed. An adapter records no id as null, never an empty string.
CREATE UNIQUE INDEX idx_deliveries_provider ON deliveries (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX idx_deliveries_dispatch_key ON deliveries (dispatch_key) WHERE dispatch_key IS NOT NULL;
-- The sweep's look for in-flight rows gone stale reads only the rows in flight, not every
-- delivery ever recorded, every minute.
CREATE INDEX idx_deliveries_in_flight ON deliveries (updated_at) WHERE status = 'dispatched';
-- An address's deliveries across sends: a webhook event that carries only an address, and
-- an erasure replacing the address on every row.
CREATE INDEX idx_deliveries_email ON deliveries (email, updated_at);

-- ---------------------------------------------------------------- publisher notifications

-- One row per event the publisher is told about by email (SPEC §8): a send went out, or
-- a send ran into a problem (the provider refusing the account, in flight too long, wedged
-- awaiting Resolve, a missed fire time). UNIQUE (send_id, kind, episode) is the dedupe,
-- where the episode is 0 for a condition a send meets at most once and the start of the
-- refusal for a refusal, so a refusal that lifts and returns is a new event. The sweep
-- records events with INSERT OR IGNORE, so a condition that persists across ticks is
-- recorded once, and delivers the pending ones afterward. The one row with no send is
-- the latest test from the settings surface (kind 'test'), kept so its outcome counts as
-- the channel's latest word.
--
-- A notification never feeds back into the send path: the send loop reads nothing here
-- and no send-path write touches this table, so one that fails cannot affect a send.
-- `status` is pending -> sent | failed | unaddressed (no destination was set when it
-- came due) | cleared (its problem had cleared before a try got through, so it would
-- describe something no longer true); `attempts` is counted BEFORE each try, so one whose
-- try was cut off by the invocation ending is tried again rather than lost, and gives up
-- at the cap. `error` is the channel's words for the last failure, shown on the settings
-- surface.
CREATE TABLE notifications (
  send_id    TEXT REFERENCES sends (id),       -- null only for a test
  kind       TEXT NOT NULL
               CHECK (kind IN ('finished', 'refused', 'stuck', 'wedged', 'missed', 'test')),
  episode    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'unaddressed', 'cleared')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (send_id, kind, episode),
  CHECK ((send_id IS NULL) = (kind = 'test'))
) STRICT;
CREATE INDEX idx_notifications_status ON notifications (status, created_at);
