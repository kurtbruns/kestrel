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
 * and is recorded (cli/dev-port.mjs) so seed and reset find this server.
 *
 * A fresh local database. A new checkout or worktree has an empty `.wrangler/state`, so every
 * D1 route would 500 until the migrations ran. The local database is probed and, when its
 * tables are missing, migrated before the server starts. Never for `--remote`.
 *
 * Per-run settings. `SIMULATE_SENDS`, `MIN_LEAD_SECONDS`, and `SUBREQUEST_BUDGET` set in the
 * shell are forwarded over `.dev.vars`, so `SIMULATE_SENDS=ses kestrel dev` picks a
 * simulation profile for one run without editing a file. A `.dev.vars` missing a setting that
 * `.dev.vars.example` gives a value is named, rather than left to differ quietly.
 *
 * Arguments after the command go to `wrangler dev` (`--remote`, for instance), except `--port`,
 * which is refused in favor of PORT. This repository's `npm run dev` (scripts/dev.mjs) adds
 * the build stamp and the editor's watch build around the same function.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { clearDevPort, writeDevPort } from "./dev-port.mjs";
import { startSweepTicker } from "./sweep-ticker.mjs";
import { captureWrangler, runWrangler, spawnWrangler } from "./wrangler.mjs";

// The port a plain `kestrel dev` prefers, matching wrangler's own default.
const PREFERRED_PORT = 8787;

// The dev settings a shell may set for one run (see the header).
const OVERRIDABLE = ["SIMULATE_SENDS", "MIN_LEAD_SECONDS", "SUBREQUEST_BUDGET"];

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
// locked by a server just stopped) doesn't trigger a needless migrate. Best-effort: a failed
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
  }

  writeDevPort(port);
  // A remote session runs against deployed resources, where the real cron and the real
  // webhooks are the ones that count.
  const stopTicker = isRemote ? () => {} : startSweepTicker(origin);
  const stop = () => {
    clearDevPort();
    stopTicker();
    onStop();
  };

  const child = spawnWrangler(["dev", "--port", port, ...originArgs, ...overrideArgs, ...argv]);

  // A signal aimed at this process alone (a harness stop, `kill <pid>`) must not leave
  // wrangler serving, the ticker calling a server that is gone, or the caller's companions
  // running. Pass it to wrangler and stop the rest, then re-raise: `once` means the re-raised
  // signal meets the default disposition and ends us. (A terminal Ctrl-C reaches the whole
  // group, wrangler included, and ends the same way.)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      child.kill(signal);
      stop();
      process.kill(process.pid, signal);
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
