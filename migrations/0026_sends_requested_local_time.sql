-- 0026_sends_requested_local_time: the local time a send's fire time was asked in (SPEC §6).
--
-- A fire time is stored as one exact moment, and stays so. When it was asked as a local time
-- (`2026-11-13T09:00`, on the publication's clock or with `time_zone`), the send also keeps that
-- local time and the zone it was read in, since the act that sets the time is the only moment
-- they can be captured: a zone's rules changing after scheduling moves the local time the moment
-- reads as, and noticing that needs what was asked. Each act that sets the fire time replaces
-- them, and one that asks an exact moment (or Send now) clears them, so they never describe a
-- time the send no longer has. Nothing reads them yet.
--
-- A send scheduled before this reads null for both, as one asked as an exact moment does.
-- Adding nullable columns rewrites no rows.

ALTER TABLE sends ADD COLUMN requested_local_time TEXT;
ALTER TABLE sends ADD COLUMN requested_time_zone TEXT;
