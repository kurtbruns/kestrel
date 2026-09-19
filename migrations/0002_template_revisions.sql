-- 0002_template_revisions — the email template gains a history, and a send pins the
-- revision it was made with (SPEC §2, §9).
--
-- One template, with history: every save writes a row here; the current template is
-- the latest, and the settings blob keeps its id (src/db/settings.ts). Rows are
-- append-only — a restore writes a NEW revision equal to an old one, never rewrites
-- one — so a send's pinned revision always still exists and still says what it said.
CREATE TABLE template_revisions (
  id       TEXT PRIMARY KEY,
  html     TEXT NOT NULL,                      -- the full template, as saved
  saved_at INTEGER NOT NULL,
  author   TEXT                                -- principal that saved it (null = the app, e.g. the first-run backfill)
);
CREATE INDEX idx_template_revisions_saved ON template_revisions (saved_at);

-- The template revision a send's render was frozen with (-> template_revisions.id).
-- Every send made from here on sets it. Nullable only for sends that predate the
-- history: their template was never recorded, so the app treats them as made with an
-- older template than the current one (an update re-freezes them and records it).
ALTER TABLE sends ADD COLUMN template_revision TEXT;
