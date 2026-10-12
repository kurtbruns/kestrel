/**
 * The schema gate (SPEC §9): whether the database has run every migration this release
 * ships, checked before the app touches it, and what to run when it hasn't.
 *
 * Running on a schema behind the code fails on whatever the release touches, as raw
 * `no such table` errors in the logs, so the app refuses instead, as it does a refused
 * configuration: `index.ts` answers every request from here, and skips the sweep. The check
 * is one read of `d1_migrations` (`db/migrations.ts`). Once a database has every migration it
 * is remembered for the isolate's life: a running release never sees its schema go backwards
 * on its own, and Upgrade's Go back deploys the old release before it restores the database.
 * While it is behind, every request reads again, so applying the migrations ends the
 * refusal without a redeploy.
 */

import { missingMigrations } from "./db/migrations";
import { errorText, log } from "./lib/log";

/** What the gate reports while the database is behind: the shipped migrations it has not
 *  run, and a sentence naming them and what to run. */
export interface SchemaGap {
  missing: string[];
  message: string;
}

const SYNC_HINT =
  "If it finds nothing to apply in an instance, run npm run sync-migrations first, which copies the release's migrations into migrations/.";

/**
 * What to run, in words. A dev-shaped server is local development on its own local database,
 * so it gets the one command. Any other can't tell a deployed Worker from a local
 * `wrangler dev` of the same settings (under `wrangler dev`, a config with routes is served
 * under the route's host), so it names both, the deployed one first, and never presents a
 * command that acts on the live database as the local fix. An instance gets a new release's
 * migrations into its folder only through `sync-migrations`, and skipping that leaves
 * `apply` with nothing to do, locally as much as deployed, so both forms say so. Kestrel's own
 * repository has no such step, which the hint's "in an instance" leaves out.
 */
function remedy(devMode: boolean, them: string): string {
  const command = devMode
    ? "npx wrangler d1 migrations apply DB --local"
    : "npx wrangler d1 migrations apply DB --remote --env production for the deployed app, or --local --env production under a local wrangler dev";
  return `Apply ${them}: ${command}. ${SYNC_HINT}`;
}

// The databases seen with every migration, so the read happens once per isolate.
const current = new WeakSet<D1Database>();

// The last gap and the last failed check logged, so a database left behind, or one the check
// can't read, logs its cause once per isolate rather than on every request and sweep tick.
let reportedGap: string | undefined;
let reportedUnchecked: string | undefined;

/**
 * The gap between this release's migrations and the database's, or undefined when there is
 * none. Undefined, too, when the check itself can't read the database: that is logged and
 * the request goes ahead, since a D1 that can't be reached is not a schema that is behind,
 * and the route's own query will fail or succeed on its own terms.
 */
export async function schemaGap(db: D1Database, devMode: boolean): Promise<SchemaGap | undefined> {
  if (current.has(db)) {
    return undefined;
  }
  let missing: string[];
  try {
    missing = await missingMigrations(db);
  } catch (err) {
    const error = errorText(err);
    if (reportedUnchecked !== error) {
      reportedUnchecked = error;
      log.warn("schema.unchecked", { error });
    }
    return undefined;
  }
  reportedUnchecked = undefined;
  if (missing.length === 0) {
    current.add(db);
    reportedGap = undefined;
    return undefined;
  }
  const key = missing.join(",");
  if (reportedGap !== key) {
    reportedGap = key;
    log.error("schema.behind", { missing: key, count: missing.length });
  }
  const n = missing.length;
  return {
    missing,
    message: `The database is missing ${n === 1 ? "a migration" : `${n} migrations`} this release needs (${missing.join(", ")}). ${remedy(devMode, n === 1 ? "it" : "them")}`,
  };
}
