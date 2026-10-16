-- 0010_unlisted_links: every post gets its own unlisted link, and every send records which
-- address its email carries (SPEC §5).
--
-- Every email's "view in browser" link used to be the post's archive address,
-- `/archive/<slug>`. That made an email-only post's page guessable from its subject, and tied
-- every email ever sent to the archive's base path. Now each post has an unlisted link,
-- `/email/<token>` on the app's own origin, which every test and send carries instead, and the
-- archive address answers only while the post is listed.
--
-- posts.unlisted_token: 128 bits of randomness, made with the post and never changed, written as
-- 32 hex digits in four groups of eight joined by hyphens, so a reader can keep their place in it.
-- A column added to an existing table can't take a per-row default, so existing posts are
-- given theirs here, and a trigger gives one to every post inserted without it, so no way of
-- inserting a post leaves it without a link. The unique index keeps every link a post's own.
--
-- sends.web_link: which address the send's email carries as its "view in browser" link,
-- `unlisted` from this release on, or `archive` for a send frozen before it. The column defaults
-- to `archive`, which every existing send takes, and this release's Worker names `unlisted` on
-- every send it freezes: a send frozen by the previous release's Worker while it still serves,
-- between this migration and the deploy or after a rollback, carries its archive address, and
-- the default records it so. A post whose
-- published send carries `archive` keeps its archive address answering whatever its listing,
-- since every copy of that email links there. A re-make freezes a new copy, so it moves a
-- scheduled send to `unlisted`.
--
-- Slugs keep the rule they have had since 0001: every post's is unique, drafts included.

ALTER TABLE posts ADD COLUMN unlisted_token TEXT;
UPDATE posts SET unlisted_token = lower(hex(randomblob(16)));
UPDATE posts SET unlisted_token = substr(unlisted_token, 1, 8) || '-' || substr(unlisted_token, 9, 8)
  || '-' || substr(unlisted_token, 17, 8) || '-' || substr(unlisted_token, 25, 8);
CREATE UNIQUE INDEX idx_posts_unlisted_token ON posts (unlisted_token);

CREATE TRIGGER posts_unlisted_token AFTER INSERT ON posts
  WHEN NEW.unlisted_token IS NULL
BEGIN
  UPDATE posts SET unlisted_token = lower(hex(randomblob(16))) WHERE id = NEW.id;
  UPDATE posts SET unlisted_token = substr(unlisted_token, 1, 8) || '-' || substr(unlisted_token, 9, 8)
    || '-' || substr(unlisted_token, 17, 8) || '-' || substr(unlisted_token, 25, 8) WHERE id = NEW.id;
END;

ALTER TABLE sends ADD COLUMN web_link TEXT NOT NULL DEFAULT 'archive'
  CHECK (web_link IN ('unlisted', 'archive'));
