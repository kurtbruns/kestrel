#!/usr/bin/env node
/*
 * The `kestrel` command: the few things an instance repository needs that wrangler doesn't
 * do. Deploying, migrating, and secrets are plain wrangler, which Cloudflare documents and
 * Claude already knows; this covers writing a new instance, local dev with the send sweep,
 * bringing a release's migrations and Claude context in, and the demo. This repository's npm scripts run the same commands, so both
 * use one implementation.
 *
 * Every command acts on the directory it runs in, except the sign-in: login, logout, and api
 * act as the person at this computer, whose sign-ins are theirs rather than a folder's. Those
 * three are Kestrel's client, published on its own as the unscoped `kestrel` (packages/kestrel),
 * which runs from anywhere and hands the instance commands back to this package. This package
 * ships the client's source too, so an instance runs every command from its own install and
 * never needs the client as a second dependency, whose `kestrel` would collide with this one.
 * Seed and reset work only against a local dev server, whose dev routes exist nowhere else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

const HELP = `kestrel ${PACKAGE.version}

Usage: kestrel <command> [options]

  init [dir]                    write a new instance repository here (or in dir)
  dev [wrangler dev args]       run locally, with the send sweep once a minute (PORT picks the port)
  sync-migrations               copy this release's migrations into migrations/
  check-context [--update]      compare the Claude files in .claude/ with this release's
  check-context --merged <file> record that you merged this release's changes into one
  seed [--size <n>] [port|url]  load the demo publication into the local dev server
  reset [port|url]              return the local dev server to a fresh install

  login <url> [--no-browser]    sign in to a deployed instance as you, in your browser
  logout [url]                  sign out of it on this computer
  api <method> <path> [opts]    call the API as you, via Claude Code (kestrel api for options)
  api --list | help <m> <path>  list the instance's routes, or describe one

  help, --help                  show this
  version, --version            print the installed version`;

const [command, ...argv] = process.argv.slice(2);

switch (command) {
  case "init":
    (await import("../cli/init.mjs")).initCommand(argv);
    break;
  case "check-context":
    (await import("../cli/context.mjs")).checkContextCommand(argv);
    break;
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
  case "login":
    await (await import("../packages/kestrel/lib/login.mjs")).loginCommand(argv);
    break;
  case "logout":
    await (await import("../packages/kestrel/lib/login.mjs")).logoutCommand(argv);
    break;
  case "api":
    await (await import("../packages/kestrel/lib/api.mjs")).apiCommand(argv);
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
