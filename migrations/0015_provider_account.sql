-- 0015_provider_account: what the provider's account last said about itself (SPEC §9).
--
-- One row, written by the sweep's account check: when it last asked (`attempted_at`), what came
-- of it (`outcome`: `ok`, `permission` for a key not allowed to ask, `unreachable` for no usable
-- answer), and the last answer it got (`answer`, JSON, with `checked_at`), which stands until a
-- newer one replaces it. It is an observation, not a preference, so it lives apart from the
-- settings row; nothing that decides whether to send reads it.
--
-- What can't be recovered: nothing. The table starts empty and fills on the first idle tick.

CREATE TABLE provider_account (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  attempted_at INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'permission', 'unreachable')),
  checked_at   INTEGER,
  answer       TEXT CHECK (answer IS NULL OR json_valid(answer)),
  CHECK ((checked_at IS NULL) = (answer IS NULL))
) STRICT;
