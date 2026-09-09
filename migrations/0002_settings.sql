-- 0002_settings — app-level runtime settings (SPEC §8).
-- A single-row JSON blob so new preferences don't each need a migration; the app
-- owns the typed shape (src/db/settings.ts). This holds ONLY runtime preferences
-- (e.g. default test recipients) — never secrets or deploy-time infrastructure,
-- which stay in env/secrets (see docs/setup/). Edited via the authed /api/settings.
CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  data       TEXT NOT NULL DEFAULT '{}',          -- JSON: the AppSettings shape
  updated_at INTEGER NOT NULL
);
