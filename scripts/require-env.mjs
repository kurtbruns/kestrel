#!/usr/bin/env node
/*
 * Run a wrangler command that reaches a deployed environment, but only when `--env` names one.
 *
 * `npm run deploy` and `npm run migrate:remote` wrap this. Without `--env`, wrangler targets
 * the top-level config, which is the development environment: the fake transport and a
 * localhost `APP_ORIGIN`. Deployed, that config counts as local dev, so a bare deploy would
 * ship a Worker that fakes every send, and a bare migrate would aim at the development
 * database, which no deployed environment reads, instead of the one being upgraded. Refusing here makes the environment an explicit
 * choice every time. Anything after `npm run <script> --` is forwarded to wrangler as is.
 *
 * Pure Node, no dependencies. `wrangler` resolves from node_modules/.bin, which npm puts on
 * PATH for every script.
 */
import { spawnSync } from "node:child_process";

const [, , ...args] = process.argv;

/** The environment named by `--env <name>`, `--env=<name>`, `-e <name>` or `-e=<name>`, or null. */
function namedEnv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = arg.match(/^(?:--env|-e)=(.*)$/);
    if (inline) {
      return inline[1] || null;
    }
    if (arg === "--env" || arg === "-e") {
      const next = argv[i + 1];
      return next && !next.startsWith("-") ? next : null;
    }
  }
  return null;
}

if (!namedEnv(args)) {
  const script = process.env.npm_lifecycle_event ?? "this command";
  console.error(
    `[${script}] refused: name the environment, for example \`npm run ${script} -- --env staging\`.\n` +
      "Without --env, wrangler targets the top-level development config (the fake transport, a localhost origin).",
  );
  process.exit(1);
}

const run = spawnSync("wrangler", args, { stdio: "inherit" });
if (run.error) {
  console.error(`[require-env] could not run wrangler: ${run.error.message}`);
}
process.exit(run.status ?? 1);
