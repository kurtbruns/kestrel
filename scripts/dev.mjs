#!/usr/bin/env node
/*
 * Dev-server launcher that bridges an externally assigned port into `wrangler dev`
 * and bootstraps a fresh local D1 shadow so a new worktree just works.
 *
 * Port: Claude Code's preview autoPort (.claude/launch.json) picks a free port when
 * the preferred one (8787) is already taken — as it is whenever another worktree or
 * session is already running `wrangler dev` — and hands the choice to the child via
 * the PORT env var. Its preflight also refuses to auto-assign when it sees a `--port`
 * flag on the launch command, so we can't just put `--port $PORT` in package.json.
 * Wrangler, in turn, ignores PORT and only accepts a `--port` flag. This launcher
 * reconciles the two: it reads PORT and forwards it as `--port`, while presenting a
 * flagless command to the harness.
 *
 * When PORT is unset — a plain terminal `npm run dev` with no harness to assign one —
 * the launcher mimics autoPort itself: it binds 8787 when that port is free, and
 * otherwise probes for a free ephemeral port, so a bare `npm run dev` survives a busy
 * 8787 (a second worktree already serving) instead of failing to bind. Set PORT
 * explicitly to pin a port. Either way the resolved port drives the origin overrides
 * below, so the absolute reader URLs always match the server we actually bind.
 *
 * DB bootstrap: each git worktree gets its own empty `.wrangler/state`, so the first
 * `npm run dev` in a fresh worktree 500s on every D1 route ("no such table: posts")
 * until the migrations are applied. We probe the local shadow and, if the table is
 * missing, apply them before starting. This is a no-op on a populated shadow
 * (`migrations apply` self-skips) and is skipped for `--remote`, so it never touches
 * the preview or production DB. (Kestrel has no dev seed, so there's nothing to seed.)
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearDevPort, writeDevPort } from "./dev-port.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The port a plain `npm run dev` prefers, matching wrangler's own default.
const PREFERRED_PORT = 8787;

// Whether a TCP port can be bound on loopback right now. A momentary check, so what it
// reports can go stale before wrangler binds — acceptable, and the same check-then-bind
// race the harness's autoPort lives with.
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

// The admin SPA is served from the tree scripts/build-client.mjs emits (see wrangler.jsonc).
// Ask for its dev flavor — readable, with the live reload compiled in — from every builder
// this process starts: the watcher below, and wrangler's own build.command, which takes no
// flag and inherits this environment.
process.env.KESTREL_CLIENT_DEV = "1";

// Resolve the build stamp (version/sha/build-time/repo) into src/generated/version.ts,
// which the Worker imports and reflects (SPEC §9). Done here, ONCE, before wrangler starts
// — deliberately NOT a wrangler `build.command`: wrangler dev watches src/, and the
// stamp's build time changes on every run, so a build command would rebuild-loop forever.
// `wrangler deploy` gets the stamp via the predeploy npm hook; the Vitest pool via
// pretest; a fresh checkout via postinstall. Best-effort — a stale stamp is harmless.
const version = spawnSync(process.execPath, [join(ROOT, "scripts", "stamp-version.mjs")], {
  stdio: "inherit",
});
if (version.status !== 0) {
  console.warn("[dev] build-version stamp failed (continuing)");
}

// Extra args after `npm run dev --` (e.g. `--remote`), forwarded to wrangler dev.
const passthrough = process.argv.slice(2);
const isRemote = passthrough.includes("--remote");

// Refuse a passthrough `--port`. We forward our own resolved `--port` to wrangler and pin the
// origin overrides below to it; a second `--port` here would rebind wrangler while the origins
// kept pointing at the resolved port, so absolute reader URLs would silently 404. PORT is the
// supported knob — it drives the bound port and the origins in lockstep.
if (passthrough.some((a) => a === "--port" || a === "-p" || a.startsWith("--port="))) {
  console.error(
    "[dev] set the port via the PORT env var, not --port: `PORT=9000 npm run dev`\n" +
      "      (PORT also reconciles APP_ORIGIN / ARCHIVE_ORIGIN / MEDIA_PUBLIC_BASE to match).",
  );
  process.exit(1);
}

// Bootstrap the local D1 shadow when its `posts` table is genuinely missing. We match
// wrangler's "no such table" error text rather than treating any non-zero exit as
// missing, so a transient probe failure (e.g. the sqlite file still locked by a
// just-stopped dev server) doesn't trigger a needless migrate. The bootstrap is
// best-effort: if it fails we warn and start the server anyway, leaving things no
// worse than an unmigrated shadow would be on its own.
if (!isRemote) {
  const probe = spawnSync(
    "wrangler",
    ["d1", "execute", "DB", "--local", "--command", "SELECT 1 FROM posts LIMIT 1"],
    { encoding: "utf8" },
  );
  const tableMissing =
    probe.status !== 0 && `${probe.stdout ?? ""}${probe.stderr ?? ""}`.includes("no such table");
  if (tableMissing) {
    console.log("[dev] fresh local D1 shadow — applying migrations…");
    const step = spawnSync("wrangler", ["d1", "migrations", "apply", "DB", "--local"], {
      stdio: "inherit",
    });
    if (step.status !== 0) {
      console.warn("[dev] migration bootstrap failed (continuing); run `npm run migrate:local`");
    }
  }
}

// Resolve the port to bind. An explicit PORT (the harness's autoPort, or set by hand)
// always wins. Otherwise mimic autoPort ourselves: prefer 8787, but fall back to a free
// ephemeral port when it's taken — a second worktree already serving — so a plain
// `npm run dev` still starts. Resolved here, as late as possible before the spawn, to
// keep the check-then-bind window small.
let port;
if (process.env.PORT) {
  port = process.env.PORT;
} else if (await isPortFree(PREFERRED_PORT)) {
  port = String(PREFERRED_PORT);
} else {
  port = String(await findFreePort());
  console.log(`[dev] port ${PREFERRED_PORT} is busy — using ${port}`);
}

// Local dev can bind a port other than 8787 (autoPort picks a free one when 8787
// is busy — e.g. a second worktree already running `wrangler dev`). Kestrel renders
// ABSOLUTE reader URLs — an email needs absolute links — from APP_ORIGIN /
// ARCHIVE_ORIGIN / MEDIA_PUBLIC_BASE, which wrangler.jsonc pins to :8787. On any
// other port those point at the wrong server, so cover images and the
// view-in-browser / unsubscribe links 404 in the browser. Reconcile them by
// overriding the origins to the port we actually bind (a no-op at 8787). Skipped for
// --remote, which runs against deployed resources under their real origins.
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

// Record the port we're binding so a separate `npm run seed` / `npm run reset` in
// another terminal targets THIS worktree's server instead of defaulting to 8787
// (see scripts/dev-port.mjs). Cleared on exit; a stale value self-heals on next start.
writeDevPort(port);

// Re-emit the served tree as client/ or public/ change, beside wrangler: esbuild's
// incremental watch (~10ms a rebuild) regenerates index.html with the new hashed names,
// and the SPA's dev-flavor poll picks that up and reloads. Wrangler's own build.command
// handles only src/ edits (see wrangler.jsonc), so exactly one process reacts to a change.
// Wrangler's startup build and this watcher's first build emit the same tree; the order
// doesn't matter.
const watcher = spawn(process.execPath, [join(ROOT, "scripts", "build-client.mjs"), "--watch"], {
  stdio: "inherit",
});
watcher.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.warn(
      `[dev] client watcher exited (${code}); run \`npm run client:watch\` to restart it`,
    );
  }
});
// A signal aimed at this process alone (a harness stop, `kill <pid>`) must not leave the
// watcher behind rewriting dist/ forever. Stop it, then re-raise: `once`
// means the re-raised signal meets the default disposition and ends us as it always did
// (a terminal Ctrl-C reaches the whole group, watcher included, and behaves the same).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    watcher.kill();
    process.kill(process.pid, signal);
  });
}

const child = spawn("wrangler", ["dev", "--port", port, ...originArgs, ...passthrough], {
  stdio: "inherit",
});

// Propagate the child's fate so `npm run dev` exits with wrangler's own status: mirror
// a fatal signal by re-raising it on ourselves, otherwise exit with its code.
child.on("exit", (code, signal) => {
  clearDevPort();
  watcher.kill();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
