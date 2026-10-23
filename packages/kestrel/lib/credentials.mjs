/*
 * Where `kestrel login` keeps a person's sign-ins, and how `kestrel api` reads them back.
 *
 * A sign-in is the person's, not an instance repository's: it is made in their browser,
 * through Cloudflare Access, as them, and it reaches every instance folder or none. So it
 * lives in their user config directory, never in the folder a command runs in, where a
 * commit or a shared worktree could carry it off: `$XDG_CONFIG_HOME/kestrel/credentials.json`,
 * `~/.config/kestrel/credentials.json` when that is unset, or `%APPDATA%\kestrel\` on
 * Windows. `KESTREL_CONFIG_DIR` names another directory, which the suite uses.
 *
 * One JSON file, keyed by the instance's origin, readable by its owner alone (0600, in a
 * 0700 directory), written whole through a temporary file and a rename, so a reader never
 * sees half of it. Each entry holds what the OAuth client needs to go on without the
 * browser: the authorization server's endpoints, the client registered for this computer,
 * the access token with its expiry, and the refresh token, which lasts as long as the
 * Access application's grant session. A file that exists but isn't one this release can
 * read is refused, never rewritten, since rewriting it would drop every sign-in it holds.
 *
 * A refresh token may be single-use, and Claude Code runs commands side by side, so a refresh
 * happens under a lock file beside the credentials: whoever waited reads the token the other
 * stored rather than spending the same refresh token twice. Every write to the file happens
 * under that lock too, since a write reads the whole file and puts it back, and two at once
 * would lose one entry's change.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = 1;

/** The directory the sign-ins live in, from the environment as described above. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.KESTREL_CONFIG_DIR) {
    return env.KESTREL_CONFIG_DIR;
  }
  if (platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "kestrel");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kestrel");
}

/** The credentials file's path. */
export function credentialsFile(env = process.env) {
  return join(configDir(env), "credentials.json");
}

/** Every stored sign-in, keyed by origin; empty when there is no file yet. Throws, naming
 *  the file, when it exists and can't be read as this release's. */
export function readSignIns(env = process.env) {
  const file = credentialsFile(env);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Couldn't read the sign-ins in ${file}: ${err?.message ?? err}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (data?.version === VERSION && data.instances && typeof data.instances === "object") {
    return data.instances;
  }
  throw new Error(
    `${file} isn't a sign-ins file this release of Kestrel can read, so it was left as it is. Move it aside, then run \`npx kestrel login <url>\` again.`,
  );
}

/** The stored sign-in for one origin, or undefined. */
export function readSignIn(origin, env = process.env) {
  return readSignIns(env)[origin];
}

/**
 * Store (or, with undefined, forget) the sign-in for one origin, leaving the others. Takes
 * the credentials lock, so call it outside `withCredentialsLock`; inside one, use
 * `writeSignInHeld`.
 */
export function writeSignIn(origin, entry, env = process.env) {
  return withCredentialsLock(() => writeSignInHeld(origin, entry, env), env);
}

/** `writeSignIn` for a caller already inside `withCredentialsLock`, which taking it again would deadlock. */
export function writeSignInHeld(origin, entry, env = process.env) {
  const instances = { ...readSignIns(env) };
  if (entry === undefined) {
    delete instances[origin];
  } else {
    instances[origin] = entry;
  }
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: VERSION, instances }, null, 2)}\n`, {
    mode: 0o600,
  });
  // The mode on create is masked by umask, so set it outright before the file takes its name.
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// How long a lock is waited for, and when one left behind by a crashed process is taken over.
/** How long a waiter waits for the lock: past the longest a live holder takes (the token request's timeout), under the staleness rule. */
export const LOCK_WAIT_MS = 25_000;
/** A lock older than this is taken over; the token request's timeout stays under it, so a live holder never outlasts it. */
export const LOCK_STALE_MS = 30_000;

/**
 * Run `fn` holding the credentials lock, so only one process refreshes at a time. A lock
 * older than any refresh takes is a crashed process's, and is taken over. The lock file holds
 * its owner's token, and the release removes the file only while it still holds that token,
 * so a holder that outlived the staleness rule never deletes the lock of whoever took over.
 */
export async function withCredentialsLock(fn, env = process.env) {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const lock = `${credentialsFile(env)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  let held = false;
  while (!held) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      held = true;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      let age = 0;
      let seen;
      try {
        seen = readFileSync(lock, "utf8");
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the open and the read: try again
      }
      if (age > LOCK_STALE_MS) {
        // Remove it only if it is still the lock we judged stale: another waiter may have
        // taken it over since, and its fresh lock is not ours to delete.
        let now;
        try {
          now = readFileSync(lock, "utf8");
        } catch {
          continue;
        }
        if (now === seen) {
          rmSync(lock, { force: true });
        }
      } else if (Date.now() > deadline) {
        throw new Error(
          `Another kestrel command has held ${lock} for ${Math.round(LOCK_WAIT_MS / 1000)} seconds. It may still be running; try again in a minute. A lock left by a crashed command clears itself after ${Math.round(LOCK_STALE_MS / 1000)} seconds.`,
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  try {
    return await fn();
  } finally {
    let owner;
    try {
      owner = readFileSync(lock, "utf8");
    } catch {
      // already gone: nothing of ours to remove
    }
    if (owner === token) {
      rmSync(lock, { force: true });
    }
  }
}
