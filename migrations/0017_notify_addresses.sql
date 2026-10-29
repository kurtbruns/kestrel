-- 0017_notify_addresses: notifications go to one or more addresses (SPEC §8).
--
-- Each address is its own delivery: `sent_to` holds the addresses a notification has reached,
-- as a JSON array, so a try after one address failed goes only to the ones still missing it,
-- never again to one that got it. Every row starts with none: one still pending reached no
-- address, since it had only the one, and one that is closed is never tried again.
--
-- The saved address itself needs no migration: the settings blob is read through code, which
-- takes a stored single address as a list of that one (`src/db/settings.ts`).
--
-- What can't be recovered: nothing. The column is added to every row.

ALTER TABLE notifications ADD COLUMN sent_to TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sent_to));
