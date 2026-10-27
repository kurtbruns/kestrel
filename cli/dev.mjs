/*
 * `kestrel dev`: run the Worker locally the way it runs deployed (SPEC §10), from this
 * repository or an instance repository.
 *
 * It wraps `wrangler dev` with what wrangler leaves out:
 *
 * The send sweep. Deployed, a cron runs it once a minute; `wrangler dev` never does. This runs
 * it at every wall-clock minute instead (cli/sweep-ticker.mjs), so a local send fires and
 * resumes when a deployed one would, and settles the simulation's receipts every few seconds,
 * as a provider's webhooks would arrive.
 *
 * The port. Claude Code's preview autoPort picks a free port when 8787 is taken (another
 * worktree already serving) and hands it over in the PORT variable, and refuses to auto-assign
 * when it sees a `--port` flag on the launch command; wrangler ignores PORT and reads only
 * `--port`. This reads PORT and forwards it as `--port`. With no PORT it prefers 8787 and
 * falls back to a free port, so a second server still starts. The resolved port drives the
 * origin overrides, so the absolute URLs an email carries point at the server actually bound,
 * and is recorded with an ID made up for this run (packages/kestrel/lib/dev-server.mjs), which the Worker is
 * handed too, so seed and reset find this server and can tell it from another directory's.
 *
 * A fresh local database. A new checkout or worktree has an empty `.wrangler/state`, so every
 * D1 route would 500 until the migrations ran. The local database is probed and, when its
 * tables are missing, migrated before the server starts. Never for `--remote`.
 *
 * Per-run settings. `SIMULATE_SENDS`, `SIMULATE_ACCOUNT`, `MIN_LEAD_SECONDS`, and
 * `SUBREQUEST_BUDGET` set in the shell are forwarded over `.dev.vars`, so `SIMULATE_SENDS=ses kestrel dev` picks a
 * simulation profile for one run without editing a file. A `.dev.vars` missing a setting that
 * `.dev.vars.example` gives a value is named, rather than left to differ quietly. What
 * `SIMULATE_SENDS` makes of this run (a simulated provider, or not connected) is said in one
 * line, since wrangler prints the variable only as "(hidden)".
 *
 * Arguments after the command go to `wrangler dev` (`--remote`, for instance), except `--port`,
 * which is refused in favor of PORT. This repository's `npm run dev` (scripts/dev.mjs) adds
 * the build stamp and the editor's watch build around the same function.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  clearDevServer,
  newDevRunId,
  writeDevServer,
} from "../packages/kestrel/lib/dev-server.mjs";
import { startSweepTicker } from "./sweep-ticker.mjs";
import { captureWrangler, runWrangler, spawnWrangler } from "./wrangler.mjs";

// The port a plain `kestrel dev` prefers, matching wrangler's own default.
const PREFERRED_PORT = 8787;

// The dev settings a shell may set for one run (see the header).
const OVERRIDABLE = ["SIMULATE_SENDS", "SIMULATE_ACCOUNT", "MIN_LEAD_SECONDS", "SUBREQUEST_BUDGET"];

// Whether a TCP port can be bound on loopback right now. A momentary check, so what it
// reports can go stale before wrangler binds: the same check-then-bind race autoPort lives with.
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

// Ask the OS for a free ephemeral port by binding :0 and reading back the assignment.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Migrate the local database when its `posts` table is genuinely missing. Wrangler's "no such
// table" text is matched rather than any failure, so a transient probe failure (the file still
// locked by a server just stopped) doesn't trigger a needless migrate. In a terminal, wrangler
// asks to confirm the migrations first, as it does for any apply. Best-effort: a failed
// bootstrap leaves things no worse than an unmigrated database would be on its own.
function bootstrapDatabase() {
  const probe = captureWrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--command",
    "SELECT 1 FROM posts LIMIT 1",
  ]);
  const missing =
    probe.status !== 0 && `${probe.stdout ?? ""}${probe.stderr ?? ""}`.includes("no such table");
  if (missing) {
    console.log("[dev] fresh local database — applying migrations…");
    if (runWrangler(["d1", "migrations", "apply", "DB", "--local"]) !== 0) {
      console.warn(
        "[dev] migration bootstrap failed (continuing); run `wrangler d1 migrations apply DB --local`",
      );
    }
  }
}

// Name the settings `.dev.vars.example` gives a value that `.dev.vars` lacks. An empty
// placeholder (a deployed provider's credentials, Access) reads the same as an absent one, and
// local dev runs without it; nor does one the shell supplies for this run count.
function checkDevVars(fromShell) {
  const settings = (file) => parseEnv(readFileSync(file, "utf8"));
  const example = join(process.cwd(), ".dev.vars.example");
  const local = join(process.cwd(), ".dev.vars");
  if (!existsSync(local)) {
    console.warn("[dev] no .dev.vars: run `cp .dev.vars.example .dev.vars` for the dev setup");
    return;
  }
  if (!existsSync(example)) {
    return;
  }
  const have = new Set([...Object.keys(settings(local)), ...fromShell]);
  const missing = Object.entries(settings(example))
    .filter(([name, value]) => value.trim() !== "" && !have.has(name))
    .map(([name]) => name);
  if (missing.length > 0) {
    console.warn(
      `[dev] .dev.vars has no ${missing.join(", ")}; copy ${missing.length === 1 ? "it" : "them"} from .dev.vars.example`,
    );
  }
}

/**
 * The line that says what stands in for a provider this run, from `SIMULATE_SENDS` as the
 * Worker will read it (the shell's value over `.dev.vars`'s), or null for the plain fake.
 * Wrangler prints the variable as "(hidden)", so without this a forgotten `not-connected`
 * in the shell looks like a broken app. The values mirror the Worker's reading of the
 * variable (src/env.ts), which stays the authority: a value it would refuse is named as such
 * here rather than called a simulation.
 */
export function simulationLine(value) {
  const v = (value ?? "").trim().toLowerCase();
  if (["", "0", "off", "false", "no"].includes(v)) {
    return null;
  }
  if (v === "not-connected") {
    return "[dev] running not connected: sends, tests and signups are refused (unset SIMULATE_SENDS to send)";
  }
  const [name = "", faults = "realistic", ...rest] = v.split(":");
  const known =
    ["generic", "ses", "1", "on", "true", "yes"].includes(name) &&
    ["realistic", "none"].includes(faults) &&
    rest.length === 0;
  return known
    ? `[dev] simulating a provider for list sends (SIMULATE_SENDS=${v}); nothing is delivered`
    : `[dev] SIMULATE_SENDS=${value.trim()} isn't a value the app accepts, so it will refuse to run: use off, ses, or generic (optionally with :none), or not-connected`;
}

/**
 * SIMULATE_SENDS as this run will have it: the shell's value when it sets a non-empty one
 * (`off` included, which overrides `.dev.vars` like any other), else `.dev.vars`'s in `dir`.
 * An empty shell value falls through, as it is not forwarded to wrangler (see `devCommand`).
 */
export function effectiveSimulateSends(shell, dir) {
  if (shell?.trim()) {
    return shell;
  }
  const local = join(dir, ".dev.vars");
  return existsSync(local) ? parseEnv(readFileSync(local, "utf8")).SIMULATE_SENDS : undefined;
}

/**
 * `kestrel dev [wrangler dev args]`. `onStop` runs when the server stops, for whatever the
 * caller started beside it.
 */
export async function devCommand(argv, { onStop = () => {} } = {}) {
  const isRemote = argv.includes("--remote");

  // A second `--port` would rebind wrangler while the origins kept pointing at the resolved
  // port, so absolute reader URLs would silently 404. PORT drives both in lockstep.
  if (argv.some((a) => a === "--port" || a === "-p" || a.startsWith("--port="))) {
    console.error(
      "[dev] set the port with the PORT variable, not --port: `PORT=9000 kestrel dev`\n" +
        "      (PORT also sets APP_ORIGIN, ARCHIVE_ORIGIN, and MEDIA_PUBLIC_BASE to match).",
    );
    process.exit(1);
  }

  if (!isRemote) {
    bootstrapDatabase();
  }

  // Resolved as late as possible before the spawn, to keep the check-then-bind window small.
  let port;
  if (process.env.PORT) {
    port = process.env.PORT;
  } else if (await isPortFree(PREFERRED_PORT)) {
    port = String(PREFERRED_PORT);
  } else {
    port = String(await findFreePort());
    console.log(`[dev] port ${PREFERRED_PORT} is busy — using ${port}`);
  }

  // Kestrel renders absolute reader URLs (an email needs them) from the origins, which the
  // dev config pins to :8787. Override them to the port actually bound (a no-op at 8787).
  // Not for --remote, which runs against deployed resources under their real origins.
  const origin = `http://localhost:${port}`;
  const originArgs = isRemote
    ? []
    : [
        "--var",
        `APP_ORIGIN:${origin}`,
        "--var",
        `ARCHIVE_ORIGIN:${origin}`,
        "--var",
        `MEDIA_PUBLIC_BASE:${origin}/media`,
      ];

  // `--var` wins over `.dev.vars`. An empty one is left out: forwarded, it would override
  // `.dev.vars` with the app's default (`MIN_LEAD_SECONDS=` would bring back the five minutes).
  const fromShell = OVERRIDABLE.filter((name) => process.env[name]?.trim());
  const overrideArgs = isRemote
    ? []
    : fromShell.flatMap((name) => ["--var", `${name}:${process.env[name]}`]);

  if (!isRemote) {
    checkDevVars(fromShell);
    const line = simulationLine(effectiveSimulateSends(process.env.SIMULATE_SENDS, process.cwd()));
    if (line) {
      console.log(line);
    }
  }

  // The Worker reports this ID beside the dev token, and seed and reset with no target given
  // check it against the record, so they never wipe a server this directory didn't start.
  // Not for --remote: its database is a deployed one, which an unnamed seed must never reach.
  const runId = newDevRunId();
  const runIdArgs = isRemote ? [] : ["--var", `DEV_RUN_ID:${runId}`];

  if (!isRemote) {
    writeDevServer(port, runId);
  }
  // A remote session runs against deployed resources, where the real cron and the real
  // webhooks are the ones that count.
  const stopTicker = isRemote ? () => {} : startSweepTicker(origin);
  const stop = () => {
    clearDevServer(runId);
    stopTicker();
    onStop();
  };

  const child = spawnWrangler([
    "dev",
    "--port",
    port,
    ...originArgs,
    ...overrideArgs,
    ...runIdArgs,
    ...argv,
  ]);

  // A signal aimed at this process alone (a harness stop, `kill <pid>`) must not leave
  // wrangler serving, the ticker calling a server that is gone, or the caller's companions
  // running. Stop the rest at once and pass the signal to wrangler, then end once wrangler has
  // (the exit handler below re-raises it), or after a few seconds if it doesn't. A terminal's
  // Ctrl-C already reaches wrangler with the whole group, so SIGINT is passed on only if
  // wrangler is still running a moment later: a second SIGINT would cut its shutdown short.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stop();
      const forward = () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      };
      if (signal === "SIGINT") {
        setTimeout(forward, 500).unref();
      } else {
        forward();
      }
      setTimeout(() => process.kill(process.pid, signal), 5000).unref();
    });
  }

  // Exit with wrangler's own status: mirror a fatal signal by re-raising it, else its code.
  child.on("exit", (code, signal) => {
    stop();
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}
