/*
 * The record of this directory's dev server, shared between `kestrel dev` (cli/dev.mjs) and
 * the seed and reset commands: the port it bound and the ID of that run.
 *
 * Why this exists: seed and reset wipe the database of whichever server they reach, and more
 * than one dev server can be running on this machine (a second worktree, an instance repository
 * beside this one). `npm run dev` can bind a port other than 8787 (Claude Code's preview
 * autoPort picks a free one and hands it over in PORT; `kestrel dev` falls back to a free one
 * when 8787 is busy), and that choice reaches only the dev child, so a `npm run seed` in another
 * terminal never sees it. The port alone isn't proof either: a server started some other way
 * (a raw `wrangler dev --port N`) leaves no record, and a record left by a server that has since
 * stopped can name a port another directory's server now holds. So `kestrel dev` makes up an ID
 * for each run, records it here with the port, and hands it to the Worker (the `DEV_RUN_ID`
 * var), which reports it beside the dev token. Seed and reset with no target given go only to
 * the recorded port, and only when the server there reports this record's ID (cli/dev-api.mjs).
 *
 * Scope: the file lives under `.wrangler/`, which is gitignored and per-directory (each worktree
 * has its own `.wrangler/state`), so the record is scoped to this directory and never committed.
 * It replaces the bare-port `.wrangler/dev-port` of earlier releases, which is removed when a dev
 * server starts and is never read: a port with no ID proves nothing.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Under the directory the command runs in: this repository, or an instance repository. The
// directory is a parameter only so the suite can point these at a scratch one.
const recordFile = (dir) => join(dir, ".wrangler", "dev-server.json");
const legacyPortFile = (dir) => join(dir, ".wrangler", "dev-port");

/** A fresh ID for one run of the dev server. */
export function newDevRunId() {
  return randomUUID();
}

/** Record the port and run ID of the dev server starting here. Best-effort: on failure there
 *  is no record, and seed and reset refuse an implicit target rather than guess one. */
export function writeDevServer(port, id, dir = process.cwd()) {
  try {
    mkdirSync(join(dir, ".wrangler"), { recursive: true });
    writeFileSync(recordFile(dir), `${JSON.stringify({ port: String(port), id })}\n`, "utf8");
    rmSync(legacyPortFile(dir), { force: true });
  } catch {
    /* best effort */
  }
}

/** Remove this run's record when its dev server exits, so a later seed/reset says no server is
 *  recorded rather than chase a port nothing is listening on. Only when the record is still
 *  this run's: a second `kestrel dev` here overwrites it, and the first one stopping must not
 *  erase the record of the one still serving. Best-effort. */
export function clearDevServer(id, dir = process.cwd()) {
  try {
    if (readDevServer(dir)?.id === id) {
      rmSync(recordFile(dir), { force: true });
    }
  } catch {
    /* best effort */
  }
}

/** The dev server last recorded in this directory, `{ port, id }`, or undefined when none is. */
export function readDevServer(dir = process.cwd()) {
  try {
    const { port, id } = JSON.parse(readFileSync(recordFile(dir), "utf8"));
    return /^\d+$/.test(String(port)) && typeof id === "string" && id
      ? { port: String(port), id }
      : undefined;
  } catch {
    return undefined;
  }
}
