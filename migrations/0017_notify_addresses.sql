-- 0017_notify_addresses: notifications go to one or more addresses (SPEC §8).
--
-- The settings row stored one address (`notifications.to`, a string, "" for none); it now stores
-- a list. The one address becomes a list of it, and "" an empty list, so an instance keeps
-- notifying exactly where it did. Its version moves on, as any write of the row does. A row
-- that isn't valid JSON is left for a person to repair, as every read already treats it.
--
-- Each address is its own delivery: `sent_to` holds the addresses a notification has reached,
-- as a JSON array, so a try after one address failed goes only to the ones still missing it,
-- never again to one that got it. Every row starts with none: one still pending reached no
-- address, since it had only the one, and one that is closed is never tried again.
--
-- What can't be recovered: nothing. Every row is carried over.

UPDATE settings
   SET data = json_set(
         data,
         '$.notifications.to',
         CASE WHEN json_extract(data, '$.notifications.to') = '' THEN json('[]')
              ELSE json_array(json_extract(data, '$.notifications.to')) END),
       updated_at = updated_at + 1
 WHERE id = 1 AND json_valid(data) AND json_type(data, '$.notifications.to') = 'text';

ALTER TABLE notifications ADD COLUMN sent_to TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sent_to));
