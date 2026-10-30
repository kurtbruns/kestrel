-- 0017_provider_account_rejected: an account check whose key SES rejects (SPEC §9).
--
-- The account check used to file a key SES doesn't know, a secret that doesn't match, and an
-- account not signed up for SES as `unreachable`, the same as no answer, so a dead key read
-- as "can't tell" and was found only by sending. It is now its own outcome, `rejected`.
-- `provider_account.outcome`'s CHECK doesn't admit it and a STRICT table's CHECK can't be
-- altered, so the table is rebuilt with `rejected` added, its one row carried over.
--
-- What can't be recovered: nothing. The row is copied as it was.

CREATE TABLE provider_account_next (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  attempted_at INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'permission', 'rejected', 'unreachable')),
  checked_at   INTEGER,
  answer       TEXT CHECK (answer IS NULL OR json_valid(answer)),
  CHECK ((checked_at IS NULL) = (answer IS NULL))
) STRICT;

INSERT INTO provider_account_next (id, attempted_at, outcome, checked_at, answer)
  SELECT id, attempted_at, outcome, checked_at, answer FROM provider_account;

DROP TABLE provider_account;
ALTER TABLE provider_account_next RENAME TO provider_account;
