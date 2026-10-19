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
-- until they confirm, as `unsubscribed_at` is.
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
-- - A complaint suppression becomes an unsubscribe whatever the subscriber's state, since the
--   complaint can no longer be dated against their confirmation. An address it held with no
--   subscriber is recorded as one, unsubscribed by a complaint and holding only the address,
--   so the publisher still can't add it back by hand.

ALTER TABLE subscribers ADD COLUMN unsubscribe_cause TEXT
  CHECK (unsubscribe_cause IN ('reader', 'publisher', 'complaint', 'erased', 'import'));

UPDATE subscribers SET unsubscribe_cause = 'reader'
 WHERE status = 'unsubscribed' OR (status = 'pending' AND unsubscribed_at IS NOT NULL);

-- A complaint is leaving: its subscriber is unsubscribed by it, the stronger cause. One who
-- had not left leaves when the complaint came, and one who had keeps when they left.
UPDATE subscribers
   SET unsubscribed_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email)
 WHERE status <> 'unsubscribed'
   AND email IN (SELECT email FROM suppressions WHERE reason IN ('complaint', 'import_complaint'));

UPDATE subscribers SET status = 'unsubscribed', unsubscribe_cause = 'complaint'
 WHERE email IN (SELECT email FROM suppressions WHERE reason IN ('complaint', 'import_complaint'));

INSERT INTO subscribers (id, email, status, unsub_token, created_at, unsubscribed_at, origin, opt_in, unsubscribe_cause)
SELECT lower(hex(randomblob(16))), p.email, 'unsubscribed', lower(hex(randomblob(32))), p.created_at, p.created_at,
       'unknown', 'unknown', 'complaint'
  FROM suppressions p
 WHERE p.reason IN ('complaint', 'import_complaint')
   AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.email = p.email);

-- An erasure's marker: the person is unsubscribed by the erasure, their record holding only
-- the address and when, with both tokens discarded (a fresh unsubscribe token no mail carries).
UPDATE subscribers
   SET status = 'unsubscribed',
       unsubscribe_cause = 'erased',
       created_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email),
       unsubscribed_at = (SELECT p.created_at FROM suppressions p WHERE p.email = subscribers.email),
       confirmed_at = NULL,
       confirm_token = NULL,
       confirm_sent_at = NULL,
       confirm_attempt_at = NULL,
       unsub_token = lower(hex(randomblob(32))),
       origin = 'unknown',
       opt_in = 'unknown',
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
SELECT lower(hex(randomblob(16))), p.email, 'unsubscribed', lower(hex(randomblob(32))), p.created_at, p.created_at,
       'unknown', 'unknown', 'erased'
  FROM suppressions p
 WHERE p.reason = 'erased'
   AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.email = p.email);

-- The suppression keeps only the sender's side. A STRICT table's CHECK can't be altered, so
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
