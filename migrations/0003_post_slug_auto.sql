-- 0003_post_slug_auto: whether a post's slug follows its subject (SPEC §4).
--
-- A slug either follows the subject or was set by hand, and the app has to know which: a
-- following slug is derived again from the subject on every draft save, so it tracks
-- subject edits and drops a numbered suffix once the slug it stood in for is free; a hand-set
-- slug is kept exactly as written. Before this column the editor guessed the mode from the
-- slug's shape, which read a hand-set `spring-update-2027` as a deduplicated
-- `spring-update`, and the server could not tell the two apart at all.
--
-- An existing post keeps its slug as hand-set (0): its slug never changes underneath it on
-- upgrade. Ticking the editor's auto toggle, or a save that sends `slug_auto`, re-links it.

ALTER TABLE posts ADD COLUMN slug_auto INTEGER NOT NULL DEFAULT 0 CHECK (slug_auto IN (0, 1));
