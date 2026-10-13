/**
 * The migrations this release ships, and which of them a database has not run (SPEC §9).
 *
 * Wrangler records each migration it applies, by file name, in the `d1_migrations` table, and
 * nothing else in the app reads that table. The list below is this release's `migrations/`
 * folder, held against it by `test/schema.spec.ts`, so a new migration that is not named here
 * fails the suite. Only these names count: an instance's own migrations (a `local_` name,
 * synced beside Kestrel's by `kestrel sync-migrations`) are its business, and a name this
 * release does not know is never reported.
 */

/** Every migration file this release ships, in the order wrangler applies them. */
export const SHIPPED_MIGRATIONS: readonly string[] = [
  "0001_init.sql",
  "0002_sends_since_1_0.sql",
  "0003_post_slug_auto.sql",
  "0004_keyed_pending_to_resolve.sql",
];

/**
 * The shipped migrations the database has not run, in order; empty when it has run them
 * all. A database wrangler has never migrated has no `d1_migrations` table at all, which
 * reads as every migration missing. Any other failure is thrown, so a D1 that can't be
 * reached is never mistaken for one that is behind.
 */
export async function missingMigrations(db: D1Database): Promise<string[]> {
  let applied: Set<string>;
  try {
    const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    applied = new Set(results.map((r) => r.name));
  } catch (err) {
    if (err instanceof Error && /no such table: d1_migrations/.test(err.message)) {
      return [...SHIPPED_MIGRATIONS];
    }
    throw err;
  }
  return SHIPPED_MIGRATIONS.filter((name) => !applied.has(name));
}
