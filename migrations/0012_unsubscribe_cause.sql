-- 0012_unsubscribe_cause: each mark has one owner (SPEC §7).
--
-- The consent state is the person's, and now keeps why they left: their own unsubscribe
-- (`reader`), the publisher on their request (`publisher`), a complaint about the mail
-- (`complaint`), an erasure (`erased`), or a list brought from elsewhere that says they left
-- with no cause (`import`). The suppression is only the sender's side: a bounce, an import's
-- bounce, or a block. A complaint and an erasure, which were suppressions, become unsubscribes
-- with their cause, and the suppression reasons that held them go.
--
-- `unsubscribe_cause` is set while a subscriber has left and not confirmed since: on every
-- unsubscribed row, and on a pending row that left and signed up again, where it is kept
-- until they confirm, as `unsubscribed_at` is. An erased subscriber holds only the address
-- and when, so its unsubscribe token, origin, and opt-in may now be empty, and only on such
-- a row. A column can be neither added with those rules nor made nullable in place, so the
-- table is rebuilt, copying every row once, with its indexes made again.
--
-- What can't be recovered:
-- - Every unsubscribe before this reads as the reader's own. The record never said whether
--   the reader, the publisher, or an import unsubscribed someone, so `reader` stands for all.
-- - An erasure that found a bounce, a complaint, or a block already on the address kept that
--   one and left no trace of itself, so its address migrates as that suppression alone (a
--   complaint's as unsubscribed by a complaint), with no subscriber saying it was erased. Its
--   bounce or block keeps the detail it had.
-- - An erasure's marker on an address with a confirmed or unsubscribed subscriber came from an
--   import that said the address was erased. The person is now unsubscribed by an erasure and
--   their record stripped, as an erasure here would. A pending subscriber with the marker
--   signed up again after it, so they stay pending, keeping that they left by an erasure until
--   they confirm.
-- - A complaint suppression becomes an unsubscribe whatever the subscriber's state, as every
--   complaint now is. An address it held with no subscriber is recorded as one, unsubscribed
--   by a complaint, so the publisher still can't add it back by hand. Nobody was erased, so it
--   gets an unsubscribe token, with how they joined recorded as unknown.

CREATE TABLE subscribers_next (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token      TEXT UNIQUE,
  confirm_sent_at    INTEGER,
  confirm_attempt_at INTEGER,
  unsub_token        TEXT UNIQUE,
  created_at         INTEGER NOT NULL,
  confirmed_at       INTEGER,
  unsubscribed_at    INTEGER,
  origin             TEXT DEFAULT 'kestrel'
                       CHECK (origin = lower(origin) AND length(origin) BETWEEN 1 AND 40),
  opt_in             TEXT DEFAULT 'double' CHECK (opt_in IN ('double', 'single', 'unknown')),
  consent_evidence   TEXT CHECK (consent_evidence IS NULL OR json_valid(consent_evidence)),
  import_id          TEXT REFERENCES imports (id),
  unsubscribe_cause  TEXT
                       CHECK (unsubscribe_cause IN ('reader', 'publisher', 'complaint', 'erased', 'import')),
  CHECK (status <> 'unsubscribed' OR unsubscribe_cause IS NOT NULL),
  CHECK (status <> 'confirmed' OR unsubscribe_cause IS NULL),
  CHECK ((unsub_token IS NOT NULL AND origin IS NOT NULL AND opt_in IS NOT NULL)
         OR (status = 'unsubscribed' AND unsubscribe_cause = 'erased'))
) STRICT;

-- Every unsubscribe before this reads as the reader own, as does a pending row that left.
INSERT INTO subscribers_next (id, email, status, confirm_token, confirm_sent_at, confirm_attempt_at,
                              unsub_token, created_at, confirmed_at, unsubscribed_at, origin, opt_in,
                              consent_evidence, import_id, unsubscribe_cause)
SELECT id, email, status, confirm_token, confirm_sent_at, confirm_attempt_at,
       unsub_token, created_at, confirmed_at, unsubscribed_at, origin, opt_in,
       consent_evidence, import_id,
       (SELECT 'reader' WHERE status = 'unsubscribed' OR (status = 'pending' AND unsubscribed_at IS NOT NULL))
  FROM subscribers;

DROP TABLE subscribers;
ALTER TABLE subscribers_next RENAME TO subscribers;
CREATE INDEX idx_subscribers_status ON subscribers (status);
CREATE INDEX idx_subscribers_created ON subscribers (created_at);

-- A complaint is leaving: its subscriber is unsubscribed by it, the stronger cause. One who
-- had not left leaves when the complaint came, and one who had keeps when they left.
UPDATE subscribers
   SET unsubscribed_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email)
 WHERE status <> 'unsubscribed' AND unsubscribed_at IS NULL
   AND email IN (SELECT email FROM suppressions WHERE reason IN ('complaint', 'import_complaint'));

UPDATE subscribers SET status = 'unsubscribed', unsubscribe_cause = 'complaint'
 WHERE email IN (SELECT email FROM suppressions WHERE reason IN ('complaint', 'import_complaint'));

INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribed_at, origin, opt_in, unsubscribe_cause)
SELECT lower(hex(randomblob(16))), p.email, 'unsubscribed', lower(hex(randomblob(32))), p.created_at, p.created_at,
       'unknown', 'unknown', 'complaint'
  FROM suppressions p
 WHERE p.reason IN ('complaint', 'import_complaint')
   AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.email = p.email);

-- An erasure marker: the person is unsubscribed by the erasure, their record holding only
-- the address and when, with both tokens and how they joined discarded.
UPDATE subscribers
   SET status = 'unsubscribed',
       unsubscribe_cause = 'erased',
       created_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email),
       unsubscribed_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email),
       confirmed_at = NULL,
       confirm_token = NULL,
       confirm_sent_at = NULL,
       confirm_attempt_at = NULL,
       unsub_token = NULL,
       origin = NULL,
       opt_in = NULL,
       consent_evidence = NULL,
       import_id = NULL
 WHERE status IN ('confirmed', 'unsubscribed')
   AND email IN (SELECT email FROM suppressions WHERE reason = 'erased');

UPDATE subscribers
   SET unsubscribe_cause = 'erased',
       unsubscribed_at = COALESCE(unsubscribed_at,
                                  (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email))
 WHERE status = 'pending'
   AND email IN (SELECT email FROM suppressions WHERE reason = 'erased');

INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribed_at, origin, opt_in, unsubscribe_cause)
SELECT lower(hex(randomblob(16))), p.email, 'unsubscribed', NULL, p.created_at, p.created_at,
       NULL, NULL, 'erased'
  FROM suppressions p
 WHERE p.reason = 'erased'
   AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.email = p.email);

-- The suppression keeps only the sender side. A STRICT table CHECK cannot be altered, so
-- it is rebuilt with the three reasons left, and the rows the others held, now carried by
-- their subscribers, are left behind.
CREATE TABLE suppressions_next (
  email      TEXT PRIMARY KEY CHECK (email = lower(email)),
  reason     TEXT NOT NULL CHECK (reason IN ('bounce', 'manual', 'import_bounce')),
  detail     TEXT,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO suppressions_next (email, reason, detail, created_at)
  SELECT email, reason, detail, created_at FROM suppressions
   WHERE reason IN ('bounce', 'manual', 'import_bounce');

DROP TABLE suppressions;
ALTER TABLE suppressions_next RENAME TO suppressions;
