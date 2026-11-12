/*
 * `kestrel sync-migrations`: copy the installed release's migration files into the
 * instance's migrations/ folder.
 *
 * Wrangler reads one migrations folder per database and records each applied file by name, so
 * Kestrel's migrations and an instance's own share the instance's folder. Kestrel's
 * files keep their exact names, because a renamed copy would run again on a database that ran
 * the original. A file already there and identical is left alone; one there that differs is
 * never overwritten, since a shipped migration is never edited and the difference is the
 * operator's to explain. An instance's own migrations take a name that can't collide with
 * Kestrel's numbering, such as a `local_` prefix.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { commandArgs } from "../packages/kestrel/lib/args.mjs";
import { CliError } from "../packages/kestrel/lib/errors.mjs";
import { PACKAGE_ROOT } from "./package.mjs";

const SHIPPED = join(PACKAGE_ROOT, "migrations");

// A file's text with LF line endings, so a checkout that turned them into CRLF (git's autocrlf
// on Windows) isn't taken for an edited migration.
const sameText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const USAGE = `Usage: kestrel sync-migrations

  Copy this release's migrations into migrations/. A file already there is never overwritten.`;

/** `kestrel sync-migrations`, into the current directory's `migrations/`. */
export function syncMigrationsCommand(argv) {
  if (commandArgs(USAGE, argv)) {
    syncMigrations(process.cwd());
  }
}

/**
 * Copy this release's migrations into `root`'s `migrations/`, saying what was added; throws a
 * CliError naming any already there that differs, after copying the rest.
 */
export function syncMigrations(root) {
  const target = join(root, "migrations");
  if (existsSync(target) && realpathSync(target) === realpathSync(SHIPPED)) {
    console.log("[sync-migrations] this is Kestrel's own repository: nothing to copy.");
    return;
  }
  mkdirSync(target, { recursive: true });
  const copied = [];
  const differ = [];
  for (const name of readdirSync(SHIPPED)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const from = join(SHIPPED, name);
    const to = join(target, name);
    if (!existsSync(to)) {
      copyFileSync(from, to);
      copied.push(name);
    } else if (sameText(to) !== sameText(from)) {
      differ.push(name);
    }
  }
  for (const name of copied) {
    console.log(`[sync-migrations] added migrations/${name}`);
  }
  if (copied.length === 0 && differ.length === 0) {
    console.log("[sync-migrations] migrations/ already has every migration this release ships.");
  }
  if (differ.length > 0) {
    throw new CliError(
      `refused to overwrite ${differ.map((n) => `migrations/${n}`).join(", ")}: it differs from the file this release ships.`,
      {
        lines: [
          "A shipped migration is never edited, so restore the release's copy, or move your change into a migration of your own (a `local_` name).",
        ],
      },
    );
  }
}
