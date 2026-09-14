/*
 * The dev server's bound port, shared between the launcher (`scripts/dev.mjs`) and
 * the seed/reset wrappers.
 *
 * Why this exists: `npm run dev` can bind a port other than 8787 — Claude Code's
 * preview autoPort picks a free one when 8787 is busy (e.g. a second worktree already
 * running `wrangler dev`) and hands the choice to the launcher via the PORT env. That
 * choice reaches only the dev child; a separate `npm run seed` / `npm run reset` in
 * another terminal never sees it, so it would default to 8787 and hit the WRONG
 * worktree's server (or nothing) — seeding one database while you're viewing another,
 * which shows up as the archive URL base of the demo not matching the server you're
 * developing against. The launcher records the port it actually bound here, and the
 * wrappers read it, so seed/reset follow the current worktree's own dev server with
 * no port passed by hand.
 *
 * Scope: the file lives under `.wrangler/`, which is gitignored AND per-worktree (each
 * worktree has its own `.wrangler/state`), so the recorded port is naturally scoped to
 * the worktree and never committed. It records the last port a dev server bound; if the
 * server isn't running, seed/reset fail with the same "is the dev server running?"
 * message as before, and the next `npm run dev` overwrites a stale value.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT_FILE = join(ROOT, ".wrangler", "dev-port");

/** Record the port the dev server bound. Best-effort: on failure seed/reset just
 *  fall back to PORT/8787, no worse than before this file existed. */
export function writeDevPort(port) {
  try {
    mkdirSync(dirname(PORT_FILE), { recursive: true });
    writeFileSync(PORT_FILE, String(port), "utf8");
  } catch {
    /* best effort */
  }
}

/** Remove the record when the dev server exits, so a later seed/reset doesn't chase
 *  a port nothing is listening on. Best-effort. */
export function clearDevPort() {
  try {
    rmSync(PORT_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

/** The port a dev server last recorded in this worktree, or undefined when none has. */
export function readDevPort() {
  try {
    const raw = readFileSync(PORT_FILE, "utf8").trim();
    return /^\d+$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}
