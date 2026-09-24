#!/usr/bin/env node
/*
 * Run a wrangler command that reaches a deployed environment, but only when one is named.
 *
 * `npm run deploy` and `npm run migrate:remote` wrap this. Without an environment, wrangler
 * targets the top-level config, which is development: the fake transport, a localhost
 * `APP_ORIGIN`, and a placeholder database. At best that fails partway; at worst it aims a
 * deploy or a migration at the wrong target. Refusing here makes the environment an
 * explicit choice every time. The environment is named the two ways wrangler itself reads
 * it: `--env` (or `-e`) after `npm run <script> --`, or the `CLOUDFLARE_ENV` variable.
 * Everything after `--` is forwarded to wrangler as is.
 *
 * Wrangler runs through Node directly rather than its `.bin` shim, so this works on Windows,
 * where the shim is a `.cmd` that Node will not spawn without a shell. Pure Node, no
 * dependencies.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

if (!namedEnv(args) && !process.env.CLOUDFLARE_ENV?.trim()) {
  const script = process.env.npm_lifecycle_event ?? "deploy";
  console.error(
    `[${script}] refused: name the environment, for example \`npm run ${script} -- --env staging\`.\n` +
      "Without one, wrangler targets the top-level development config (the fake transport, a localhost origin).",
  );
  process.exit(1);
}

// The package exports only its library entry (wrangler-dist/cli.js); the CLI sits beside it.
const cli = join(
  dirname(createRequire(import.meta.url).resolve("wrangler")),
  "..",
  "bin",
  "wrangler.js",
);
const run = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
if (run.error) {
  console.error(`[require-env] could not run wrangler: ${run.error.message}`);
}
process.exit(run.status ?? 1);
