-- 0003_post_slug_auto: whether a post's slug follows its subject (SPEC §4).
--
-- A slug either follows the subject or was set by hand, and the app has to know which. A
-- slug that follows is derived from the subject again on every draft save, so it tracks
-- subject edits and drops a number it no longer needs once the slug it stood in for is
-- free; a slug set by hand is kept exactly as written. Before this column the editor
-- guessed the mode from the slug's shape, which read `spring-update-2027` set by hand as a
-- numbered `spring-update`, and the server could not tell the two apart at all.
--
-- An existing post reads as set by hand (0), so an upgrade never moves its slug. Ticking
-- the editor's "Auto-generate from subject" box, or a save that sends `slug_auto: true`,
-- has it follow the subject again.

ALTER TABLE posts ADD COLUMN slug_auto INTEGER NOT NULL DEFAULT 0 CHECK (slug_auto IN (0, 1));
