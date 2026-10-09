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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// A file's text with LF line endings, so a checkout that turned them into CRLF (git's autocrlf
// on Windows) isn't taken for an edited migration.
const sameText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** `kestrel sync-migrations`, into the `migrations/` of `root` (the current directory). */
export function syncMigrationsCommand(root = process.cwd()) {
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
    console.error(
      `[sync-migrations] refused to overwrite ${differ.map((n) => `migrations/${n}`).join(", ")}: ` +
        "it differs from the file this release ships. A shipped migration is never edited, so " +
        "restore the release's copy, or move your change into a migration of your own (a `local_` name).",
    );
    process.exit(1);
  }
}
