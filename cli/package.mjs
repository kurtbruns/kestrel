/*
 * The instance package the cli/ commands ship in: where it is installed, and its package.json,
 * read once for every command that names its release or copies what it ships.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The root of the installed `@kurtbruns/kestrel` (this repository, when run from it). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Its package.json. */
export const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
