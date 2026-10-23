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
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_COMMANDS, INSTANCE_PACKAGE, runInstanceCommand } from "../lib/handoff.mjs";

const PACKAGE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

const HELP = `kestrel ${PACKAGE.version}

Usage: kestrel <command> [options]

  login <url> [--no-browser]    sign in to a deployed instance as you, in your browser
  logout [url]                  sign out of it on this computer
  api <method> <path> [opts]    call the API as you, via Claude Code (kestrel api for options)
  api --list | help <m> <path>  list the instance's routes, or describe one

  init [dir]                    write a new instance repository here (or in dir)
  dev, seed, reset, sync-migrations, check-context
                                run in an instance's repository, by its ${INSTANCE_PACKAGE}

  help, --help                  show this
  version, --version            print this client's version`;

const [command, ...argv] = process.argv.slice(2);

if (INSTANCE_COMMANDS.includes(command)) {
  runInstanceCommand(command, argv, PACKAGE.version);
} else {
  switch (command) {
    case "login":
      await (await import("../lib/login.mjs")).loginCommand(argv);
      break;
    case "logout":
      await (await import("../lib/login.mjs")).logoutCommand(argv);
      break;
    case "api":
      await (await import("../lib/api.mjs")).apiCommand(argv);
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
}
