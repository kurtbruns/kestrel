-- 0028_sends_rendered_web: the post's content as web HTML, frozen with the send (SPEC §5).
--
-- The one render path makes the email (`rendered_html`, `rendered_text`) and, beside it, the
-- post's content alone as HTML, with no email layout, template, or delivery placeholders. The
-- archive's feed carries that, so a feed reader gets the post in full, formatted, as it was
-- reviewed and mailed. It is frozen by the schedule and every re-make, like the email beside it.
--
-- A send frozen before this reads null, and its feed item falls back to the frozen plain text:
-- re-rendering an old post would be a copy that may differ from what went out (I3). Adding a
-- nullable column rewrites no rows.

ALTER TABLE sends ADD COLUMN rendered_web TEXT;
