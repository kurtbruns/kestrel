-- 0024_sends_halt_recipient: the reader a send's hold names, when it can name one (SPEC §12).
--
-- A send held because the provider refused a request as invalid without naming anyone now
-- names the one recipient that request carried, when it carried one, so the publisher can
-- block that address to let the send carry on. Kept beside the halt it explains and cleared
-- with it; an erasure clears it too, since the address leaves the record then. Adding a
-- nullable column rewrites no rows: a send held before it reads null, and names no one, as
-- it did.

ALTER TABLE sends ADD COLUMN halt_recipient TEXT;
