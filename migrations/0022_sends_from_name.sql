-- 0022_sends_from_name: the display name a send goes out under, frozen with its render (SPEC §9).
--
-- The `From:` display name now follows the publication's name, unless a name is written into
-- the deploy-time From address, and is part of the email the publisher reviews: the freeze and
-- every re-make store the name the sender rule gave at that moment beside the frozen copy, so a
-- rename while posts are scheduled reaches them only through the same confirmation a template
-- change takes, and what fires is what was last frozen (I3). Stored as "" for a send frozen
-- with no name, which goes out with no display name.
--
-- A send frozen before the name was kept reads null, and goes out under the rule as it stands
-- when it fires: its publisher never confirmed a frozen name, and the name in use then is the
-- one every other surface shows. Adding a nullable column rewrites no rows.

ALTER TABLE sends ADD COLUMN from_name TEXT;
