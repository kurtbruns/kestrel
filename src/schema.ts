/**
 * The schema gate (SPEC §9): whether the database has run every migration this release
 * ships, checked before the app touches it, and the command that closes the gap when not.
 *
 * Running on a schema behind the code fails on whatever the release touches, as raw
 * `no such table` errors in the logs, so the app refuses instead, as it does a refused
 * configuration: `index.ts` answers every request from here, and skips the sweep. The check
 * is one read of `d1_migrations` (`db/migrations.ts`). Once a database has every migration it
 * is remembered for the isolate's life, since a schema never goes backwards under a running
 * release; while it is behind, every request reads again, so applying the migrations ends
 * the refusal without a redeploy.
 */

import { missingMigrations } from "./db/migrations";
import { errorText, log } from "./lib/log";

/** Where the database the Worker is bound to lives, which decides the command that migrates
 *  it: a dev-shaped local server's own, a local `wrangler dev --env production`'s, or the
 *  deployed one. */
export type DatabaseSite = "dev" | "local" | "remote";

/** What the gate reports while the database is behind: the shipped migrations it has not run,
 *  the command that applies them, and both in one sentence. */
export interface SchemaGap {
  missing: string[];
  command: string;
  message: string;
}

/** The command that applies the migrations to the database at `site`. Deployed, it names
 *  `production`, the environment the setup guide creates; an operator with another applies
 *  it with that environment's name. */
export function migrateCommand(site: DatabaseSite): string {
  switch (site) {
    case "dev":
      return "npx wrangler d1 migrations apply DB --local";
    case "local":
      return "npx wrangler d1 migrations apply DB --local --env production";
    case "remote":
      return "npx wrangler d1 migrations apply DB --remote --env production";
  }
}

// The databases seen with every migration, so the read happens once per isolate.
const current = new WeakSet<D1Database>();

// The last gap logged, so a database left behind logs its cause once per isolate rather
// than on every request and every sweep tick.
let reportedGap: string | undefined;

/**
 * The gap between this release's migrations and the database's, or undefined when there is
 * none. Undefined, too, when the check itself can't read the database: that is logged and
 * the request goes ahead, since a D1 that can't be reached is not a schema that is behind,
 * and the route's own query will fail or succeed on its own terms.
 */
export async function schemaGap(
  db: D1Database,
  site: DatabaseSite,
): Promise<SchemaGap | undefined> {
  if (current.has(db)) {
    return undefined;
  }
  let missing: string[];
  try {
    missing = await missingMigrations(db);
  } catch (err) {
    log.warn("schema.unchecked", { error: errorText(err) });
    return undefined;
  }
  if (missing.length === 0) {
    current.add(db);
    reportedGap = undefined;
    return undefined;
  }
  const command = migrateCommand(site);
  const key = missing.join(",");
  if (reportedGap !== key) {
    reportedGap = key;
    log.error("schema.behind", { missing: key, count: missing.length });
  }
  const n = missing.length;
  return {
    missing,
    command,
    message: `The database is missing ${n === 1 ? "a migration" : `${n} migrations`} this release needs (${missing.join(", ")}). Apply ${n === 1 ? "it" : "them"}: ${command}`,
  };
}

/** Where the database is, from what the Worker can see: a dev-shaped instance is local
 *  development; any other answering on a loopback host is `wrangler dev` with a deployed
 *  environment's settings, on its local database; everything else is deployed. */
export function databaseSite(devMode: boolean, hostname: string): DatabaseSite {
  if (devMode) {
    return "dev";
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
    ? "local"
    : "remote";
}
