-- 0016_held_receipts: receipts that name a message the record has not yet learned (SPEC §10).
--
-- The send loop writes a recipient's provider message id when the provider answers the batch,
-- and the provider can report a bounce, complaint, or delivery for that message before then. A
-- receipt that names a message no delivery row holds yet, for an address with a recipient still
-- in flight, is kept here (`provider_id`, the address, the event and its words, when it arrived,
-- and `delivery_id`, the in-flight recipient it waits for) and applied to the record by the
-- sweep once a row holds that id, or once the publisher resolves that recipient as sent; it
-- lands on no other row. One that has waited a day is discarded. The list
-- already acted on it when it arrived, so nothing here suppresses or unsubscribes anyone.
--
-- What can't be recovered: nothing. The table starts empty.

CREATE TABLE held_receipts (
  id          INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  email       TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('delivered', 'bounced', 'complained')),
  detail      TEXT,
  hard        INTEGER CHECK (hard IN (0, 1)),
  at          INTEGER NOT NULL,
  delivery_id INTEGER NOT NULL
) STRICT;

-- Erasure discards an address's held receipts by address.
CREATE INDEX idx_held_receipts_email ON held_receipts (email);
