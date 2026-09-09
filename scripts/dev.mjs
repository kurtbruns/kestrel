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
 * reconciles the two: it reads PORT (falling back to wrangler's usual 8787 for a plain
 * `npm run dev`) and forwards it as `--port`, while presenting a flagless command to
 * the harness.
 *
 * DB bootstrap: each git worktree gets its own empty `.wrangler/state`, so the first
 * `npm run dev` in a fresh worktree 500s on every D1 route ("no such table: posts")
 * until the migrations are applied. We probe the local shadow and, if the table is
 * missing, apply them before starting. This is a no-op on a populated shadow
 * (`migrations apply` self-skips) and is skipped for `--remote`, so it never touches
 * the preview or production DB. (Kestrel has no dev seed, so there's nothing to seed.)
 */
import { spawn, spawnSync } from "node:child_process";

const port = process.env.PORT || "8787";
// Extra args after `npm run dev --` (e.g. `--remote`), forwarded to wrangler dev.
const passthrough = process.argv.slice(2);

// Bootstrap the local D1 shadow when its `posts` table is genuinely missing. We match
// wrangler's "no such table" error text rather than treating any non-zero exit as
// missing, so a transient probe failure (e.g. the sqlite file still locked by a
// just-stopped dev server) doesn't trigger a needless migrate. The bootstrap is
// best-effort: if it fails we warn and start the server anyway, leaving things no
// worse than an unmigrated shadow would be on its own.
if (!passthrough.includes("--remote")) {
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

const child = spawn("wrangler", ["dev", "--port", port, ...passthrough], {
  stdio: "inherit",
});

// Propagate the child's fate so `npm run dev` exits with wrangler's own status: mirror
// a fatal signal by re-raising it on ourselves, otherwise exit with its code.
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
