#!/usr/bin/env node
/*
 * The `kestrel` command: the few things an instance repository needs that wrangler doesn't
 * do. Deploying, migrating, and secrets are plain wrangler, which Cloudflare documents and
 * Claude already knows; this covers writing a new instance, local dev with the send sweep,
 * bringing a release's migrations and Claude context in, and the demo. This repository's npm
 * scripts run the same commands, so both use one implementation.
 *
 * Every command acts on the directory it runs in, except the sign-in: login, logout, and api
 * act as the person at this computer, whose sign-ins are theirs rather than a folder's. Those
 * three are Kestrel's client, published on its own as the unscoped `kestrel` (packages/kestrel),
 * which runs from anywhere and hands the instance commands back to this package. This package
 * ships the client's source too, so an instance runs every command from its own install and
 * never needs the client as a second dependency, whose `kestrel` would collide with this one.
 * Seed and reset work only against a local dev server, whose dev routes exist nowhere else.
 *
 * The command list, the help, and how a command's error is printed are shared with the client's
 * script (packages/kestrel/lib/commands.mjs); this says only how each command runs here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../packages/kestrel/lib/commands.mjs";

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

// How this package runs each command: every one from its own install, the client's included.
await main(process.argv.slice(2), {
  version: PACKAGE.version,
  run: {
    init: async (argv) => (await import("../cli/init.mjs")).initCommand(argv),
    dev: async (argv) => (await import("../cli/dev.mjs")).devCommand(argv),
    "sync-migrations": async (argv) =>
      (await import("../cli/sync-migrations.mjs")).syncMigrationsCommand(argv),
    "check-context": async (argv) => (await import("../cli/context.mjs")).checkContextCommand(argv),
    seed: async (argv) => (await import("../cli/seed.mjs")).seedCommand(argv),
    reset: async (argv) => (await import("../cli/reset.mjs")).resetCommand(argv),
    login: async (argv) => (await import("../packages/kestrel/lib/login.mjs")).loginCommand(argv),
    logout: async (argv) => (await import("../packages/kestrel/lib/login.mjs")).logoutCommand(argv),
    api: async (argv) => (await import("../packages/kestrel/lib/api.mjs")).apiCommand(argv),
  },
});
