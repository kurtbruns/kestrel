-- 0007_post_email_only: whether a post is listed in the public archive (SPEC §5).
--
-- A post is in the archive (0, the default) or email only (1): mailed exactly as a listed
-- post is, but left out of the archive index and the landing page, its post page still
-- answering at its permanent address. The listing belongs to the post, not to a send,
-- because it is not part of the frozen render: changing it never re-makes a scheduled send's
-- email or touches a sent one (I3), and it can be changed after the post is sent.
--
-- Every existing post reads as in the archive, so an upgrade lists exactly what it listed
-- before. Adding a column with a constant default rewrites no rows.

ALTER TABLE posts ADD COLUMN email_only INTEGER NOT NULL DEFAULT 0 CHECK (email_only IN (0, 1));
