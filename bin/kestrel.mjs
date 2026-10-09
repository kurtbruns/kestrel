#!/usr/bin/env node
/*
 * The `kestrel` command: the few things an instance repository needs that wrangler doesn't
 * do. Deploying, migrating, and secrets are plain wrangler, which Cloudflare documents and
 * Claude already knows; this covers local dev with the send sweep, bringing a release's
 * migrations in, and the demo. This repository's npm scripts run the same commands, so both
 * use one implementation.
 *
 * Every command acts on the directory it runs in. Seed and reset work only against a local
 * dev server, whose dev routes exist nowhere else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

const HELP = `kestrel ${PACKAGE.version}

Usage: kestrel <command> [options]

  dev [wrangler dev args]       run locally, with the send sweep once a minute (PORT picks the port)
  sync-migrations               copy this release's migrations into migrations/
  seed [--size <n>] [port|url]  load the demo publication into the local dev server
  reset [port|url]              return the local dev server to a fresh install

  help, --help                  show this
  version, --version            print the installed version`;

const [command, ...argv] = process.argv.slice(2);

switch (command) {
  case "dev":
    await (await import("../cli/dev.mjs")).devCommand(argv);
    break;
  case "sync-migrations":
    (await import("../cli/sync-migrations.mjs")).syncMigrationsCommand();
    break;
  case "seed":
    await (await import("../cli/seed.mjs")).seedCommand(argv);
    break;
  case "reset":
    await (await import("../cli/reset.mjs")).resetCommand(argv);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(PACKAGE.version);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`kestrel: unknown command "${command}"\n\n${HELP}`);
    process.exit(1);
}
