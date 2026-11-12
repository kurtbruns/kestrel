#!/usr/bin/env node
/*
 * The `kestrel` command as published under the unscoped name: Kestrel's client, which runs
 * from anywhere (`npx kestrel login <url>`, `npx kestrel api …`). It signs a person in to a
 * deployed instance and calls its API as them, reading what the API is from the instance's own
 * OpenAPI document, so it needs none of the instance's code and works with any release.
 *
 * The commands that act on an instance's repository (init, dev, and the rest) belong to the
 * release that instance runs, so they live in `@kurtbruns/kestrel`, and this hands them to that
 * install (lib/handoff.mjs). The instance package ships this same client source, so in an
 * instance's repository, where its `kestrel` is the one npx finds, nothing else is needed.
 *
 * The command list, the help, and how a command's error is printed are shared with the instance
 * package's script (lib/commands.mjs); this says only how each command runs here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_COMMANDS, main } from "../lib/commands.mjs";
import { runInstanceCommand } from "../lib/handoff.mjs";

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

// How the client runs each command: its own here, an instance's through the instance package.
const signIn = (name) => async (argv) => (await import("../lib/login.mjs"))[name](argv);

await main(process.argv.slice(2), {
  version: PACKAGE.version,
  run: {
    ...Object.fromEntries(
      INSTANCE_COMMANDS.map((name) => [
        name,
        (argv) => runInstanceCommand(name, argv, PACKAGE.version),
      ]),
    ),
    login: signIn("loginCommand"),
    logout: signIn("logoutCommand"),
    api: async (argv) => (await import("../lib/api.mjs")).apiCommand(argv),
  },
});
