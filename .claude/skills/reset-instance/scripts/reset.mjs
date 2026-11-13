#!/usr/bin/env node
// The maintainer's reset, run against one instance's repository through its own wrangler:
// `inspect` reads the instance and prints what a reset would delete and what the maintainer
// has to say yes to, and `clear` does it, only for the state `inspect` showed. What is cleared,
// kept, and refused is plan.mjs; SKILL.md says when each command runs and what the person is
// asked. Plain Node, no dependency but the instance's wrangler.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLEARED, clearSql, judge, KEPT, QUERIES } from "./plan.mjs";

const USAGE = `usage:
  reset.mjs inspect <instance-dir> [--local]
  reset.mjs clear   <instance-dir> --fingerprint <value from inspect> [--local]

Without --local it acts on the instance's production environment (--remote --env production).
With --local it acts on the local database and bucket \`wrangler dev\` uses in that directory.`;

/** A reason to stop, said to the person in words, with the exit code the command ends on. */
export class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * The command line, read strictly: a flag it doesn't know is refused, never ignored, since a
 * mistyped `--local` would otherwise read production.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "clear") {
    throw new Stop(USAGE);
  }
  let dir = null;
  let local = false;
  let fingerprint = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--local") {
      local = true;
    } else if (arg === "--fingerprint") {
      fingerprint = rest[++i] ?? null;
      if (fingerprint === null || fingerprint.startsWith("--")) {
        throw new Stop(`--fingerprint needs the value inspect printed.\n\n${USAGE}`);
      }
    } else if (arg.startsWith("-")) {
      throw new Stop(`Unknown option ${arg}. Nothing was read or changed.\n\n${USAGE}`);
    } else if (arg === "") {
      throw new Stop(
        `An empty instance directory was given. Nothing was read or changed.\n\n${USAGE}`,
      );
    } else if (dir === null) {
      dir = arg;
    } else {
      throw new Stop(`One instance directory at a time: ${dir}, then ${arg}.\n\n${USAGE}`);
    }
  }
  if (dir === null) {
    throw new Stop(USAGE);
  }
  if (command === "clear" && fingerprint === null) {
    throw new Stop(`clear needs the fingerprint inspect printed.\n\n${USAGE}`);
  }
  if (command === "inspect" && fingerprint !== null) {
    throw new Stop(`inspect takes no fingerprint.\n\n${USAGE}`);
  }
  return { command, dir, local, fingerprint };
}

/** JSON with comments and trailing commas, as wrangler.jsonc is written. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      out += text.slice(start, i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === "}" || c === "]") {
      // A trailing comma, dropped here, outside any string: what was copied so far ends in one.
      out = out.replace(/,\s*$/, "") + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/** Where the instance's data lives, read from its wrangler.jsonc: production's, or with
 *  `--local` the development environment's. */
export function target(dir, local) {
  const path = join(dir, "wrangler.jsonc");
  if (!existsSync(path)) {
    throw new Stop(`${dir} has no wrangler.jsonc, so it isn't an instance's repository.`);
  }
  const config = parseJsonc(readFileSync(path, "utf8"));
  const env = local ? config : config.env?.production;
  if (!env) {
    throw new Stop(`${path} declares no production environment.`);
  }
  const database = env.d1_databases?.find((d) => d.binding === "DB");
  const bucket = env.r2_buckets?.find((b) => b.binding === "MEDIA");
  if (!database?.database_name || !bucket?.bucket_name) {
    throw new Stop(
      `${path} doesn't declare the DB database and the MEDIA bucket for this environment.`,
    );
  }
  const wrangler = join(dir, "node_modules", ".bin", "wrangler");
  if (!existsSync(wrangler)) {
    throw new Stop(`${dir} has no wrangler installed. Run \`npm install\` there first.`);
  }
  return {
    dir,
    local,
    wrangler,
    // The file this read, named on every call: wrangler would otherwise prefer a
    // wrangler.json beside it, and act on another database than the one named back.
    config: path,
    where: local ? ["--local"] : ["--remote", "--env", "production"],
    environment: local ? "local development" : "production",
    origin: env.vars?.APP_ORIGIN ?? "(no APP_ORIGIN)",
    database: database.database_name,
    bucket: bucket.bucket_name,
  };
}

function wrangler(t, args) {
  return execFileSync(t.wrangler, [...args, "--config", t.config], {
    cwd: t.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const lastLine = (error) =>
  String(error.stderr || error.stdout || error.message)
    .trim()
    .split("\n")
    .pop();

/** One SELECT's rows. A remote `--file` run prints no rows, so every read is a `--command`. */
function rows(t, sql) {
  const out = wrangler(t, ["d1", "execute", "DB", ...t.where, "--json", "--command", sql]);
  let results;
  try {
    results = JSON.parse(out.slice(out.indexOf("[")))[0]?.results;
  } catch {
    results = undefined;
  }
  if (!Array.isArray(results)) {
    throw new Stop(`wrangler answered without rows for: ${sql}\n${out}`);
  }
  return results;
}

function readAll(t) {
  const read = Object.fromEntries(Object.keys(QUERIES).map((name) => [name, []]));
  read.tables = rows(t, QUERIES.tables);
  const schema = judge(read, Date.now());
  if (schema.refusals.length > 0) {
    // A schema this skill doesn't know: the other queries may not even run.
    return schema;
  }
  for (const [name, sql] of Object.entries(QUERIES)) {
    if (name !== "tables") {
      read[name] = rows(t, sql);
    }
  }
  return judge(read, Date.now());
}

/** What a yes covers, as one short value: where the instance is and everything `judge` says
 *  the person was shown. */
export function fingerprintOf(t, verdict) {
  return createHash("sha256")
    .update(JSON.stringify([t.environment, t.origin, t.database, t.bucket, verdict.fingerprint]))
    .digest("hex")
    .slice(0, 16);
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function printInstance(t, toName) {
  console.log(`Instance (${t.environment})`);
  console.log(`  publication: ${toName?.publication?.name || "(no name set)"}`);
  console.log(`  address:     ${t.origin}`);
  console.log(`  database:    ${t.database}`);
  console.log(`  bucket:      ${t.bucket}`);
  console.log(`  repository:  ${t.dir}`);
}

function refused(refusals) {
  return new Stop(
    `\nREFUSED. Nothing was changed, and nothing here may be worked around:\n${refusals.map((r) => `  - ${r}`).join("\n")}`,
    2,
  );
}

function list(title, lines) {
  console.log(`\n${title} (${lines.length})`);
  for (const line of lines.length > 0 ? lines : ["none"]) {
    console.log(`  ${line}`);
  }
}

export function inspect(t) {
  const verdict = readAll(t);
  printInstance(t, verdict.toName);
  if (verdict.refusals.length > 0) {
    throw refused(verdict.refusals);
  }
  const n = verdict.toName;

  console.log("\nWho wrote and acted here");
  console.log(
    `  ${n.author ?? "no person"}${n.serviceActed ? ", and a service token" : ""}${n.author || n.serviceActed ? "" : " (no revision, act, or import)"}`,
  );

  list("Test recipients", n.testRecipients);
  list(
    "Addresses that aren't test recipients",
    n.addresses.map((a) => `${a.email}: ${a.what}`),
  );
  if (n.erased > 0) {
    console.log(`  plus ${n.erased} erased subscriber(s), whose do-not-contact record goes too`);
  }
  list("Pending signups, never confirmed", n.pending);
  list(
    "Sent posts, whose record nothing else can delete",
    n.sent.map(
      (s) =>
        `"${s.subject}", ${day(s.fireAt)}, mailed to ${s.recipients}, ${s.listed ? "LISTED in the public archive" : "email only"}`,
    ),
  );

  console.log("\nWhat a reset deletes");
  for (const table of CLEARED) {
    console.log(`  ${table}: ${n.counts[table]}`);
  }
  console.log(`  post images in the bucket: ${n.images.length}`);
  for (const key of n.strayImages) {
    console.log(`  NOT deleted, since it isn't a post's image: ${key}`);
  }
  console.log("\nWhat it keeps");
  console.log(
    `  settings (name, template, time zone ${n.publication?.time_zone ?? "not set"}, notification addresses, test recipients), the sending and provider_account rows, and logos in the bucket`,
  );
  if (n.refusedByProvider.length > 0) {
    list(
      "The provider's own suppression list is left alone, and may still refuse",
      n.refusedByProvider,
    );
  }
  console.log(`\nfingerprint: ${fingerprintOf(t, verdict)}`);
}

function bookmark(t) {
  if (t.local) {
    return null;
  }
  let out;
  let found;
  try {
    out = wrangler(t, ["d1", "time-travel", "info", "DB", "--env", "production", "--json"]);
    found = JSON.parse(out.slice(out.indexOf("{"))).bookmark;
  } catch (error) {
    out = lastLine(error);
  }
  if (typeof found !== "string" || found === "") {
    throw new Stop(`No restore point could be read, so nothing was changed.\n${out}`);
  }
  return found;
}

export function clear(t, expected) {
  const verdict = readAll(t);
  printInstance(t, verdict.toName);
  if (verdict.refusals.length > 0) {
    throw refused(verdict.refusals);
  }
  const fingerprint = fingerprintOf(t, verdict);
  if (fingerprint !== expected) {
    throw new Stop(
      `\nREFUSED. The instance is not as it was when it was inspected (fingerprint ${fingerprint}, not ${expected}). Nothing was changed. Inspect it again and show the person what is there now.`,
      2,
    );
  }
  const before = verdict.toName;
  const restorePoint = bookmark(t);
  const startedAt = new Date().toISOString();
  // Said before anything is deleted, so both are on the screen whatever happens next: once
  // the image rows are gone, nothing else names these objects.
  if (restorePoint) {
    console.log(`\nRestore point (database only, before the clear): ${restorePoint}`);
  }
  if (before.images.length > 0) {
    console.log(`\nPost images in ${t.bucket}, deleted once their rows are gone:`);
    for (const key of before.images) {
      console.log(`  ${key}`);
    }
  }

  // A failed command is not proof that nothing was deleted: wrangler can lose the answer to
  // a file the database went on to run. So the failure is kept, and the counts decide.
  let failure = null;
  const scratch = mkdtempSync(join(tmpdir(), "kestrel-reset-"));
  try {
    const file = join(scratch, "clear.sql");
    writeFileSync(file, clearSql());
    wrangler(t, ["d1", "execute", "DB", ...t.where, "--yes", "--file", file]);
  } catch (error) {
    failure = lastLine(error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Read back: a remote file run prints no rows, and Cloudflare doesn't promise it is atomic.
  let after;
  try {
    after = rows(t, QUERIES.counts)[0];
  } catch (error) {
    throw new Stop(
      `\n${failure ? `The clear failed: ${failure}\n` : ""}What the clear did could not be read back: ${lastLine(error)}\nNo image was deleted. Inspect again to see what is left. If the images' rows are gone, the keys printed above are the only record of them.`,
      3,
    );
  }
  const left = CLEARED.filter((table) => after[table] !== 0);
  if (failure) {
    console.log(`\nThe clear's command failed: ${failure}`);
  }

  // The images go once their rows are gone, whatever else is left: from then on nothing in
  // the database names them, so a later run could never find them to delete.
  const failed = [];
  const imagesGone = after.images === 0;
  if (imagesGone) {
    for (const key of before.images) {
      try {
        wrangler(t, [
          "r2",
          "object",
          "delete",
          `${t.bucket}/${key}`,
          t.local ? "--local" : "--remote",
        ]);
      } catch (error) {
        failed.push(`${key}: ${lastLine(error)}`);
      }
    }
  }

  console.log(left.length > 0 ? "\nRESET NOT FINISHED" : "\nRESET DONE");
  console.log(`  when:        ${startedAt}`);
  for (const table of CLEARED) {
    const gone = before.counts[table] - after[table];
    if (gone > 0) {
      console.log(`  deleted:     ${gone} from ${table}`);
    }
  }
  if (imagesGone) {
    console.log(
      `  images:      ${before.images.length - failed.length} of ${before.images.length} deleted from ${t.bucket}`,
    );
  } else {
    console.log("  images:      none deleted, since their rows are still there");
  }
  for (const line of failed) {
    console.log(`  NOT deleted: ${line}`);
  }
  for (const key of before.strayImages) {
    console.log(`  NOT deleted, since it isn't a post's image: ${key}`);
  }
  const moved = KEPT.filter((table) => after[table] !== before.counts[table]);
  console.log(
    `  kept:        ${KEPT.map((table) => `${table} (${after[table]} row(s))`).join(", ")}${moved.length ? `; ${moved.join(", ")} changed while this ran, by the app` : ""}`,
  );
  if (restorePoint) {
    console.log(`  restore point (database only, before the clear): ${restorePoint}`);
    console.log(
      "               Time Travel keeps it 30 days on Workers Paid, 7 on Free. A restore brings back no image.",
    );
  }
  for (const email of before.refusedByProvider) {
    console.log(`  the provider's suppression list may still refuse: ${email}`);
  }
  console.log(
    `  A row the app wrote in the moment between the last look and the clear went with the rest, unseen.${restorePoint ? " The restore point holds it." : ""}`,
  );
  if (left.length > 0) {
    throw new Stop(
      `\n${left.join(", ")} still hold rows: the clear stopped partway, or the app wrote while it ran. Inspect again, show the person what is there now, and clear again.`,
      3,
    );
  }
  if (failed.length > 0) {
    throw new Stop("\nSome images were not deleted. Their keys are above.", 3);
  }
}

export function main(argv) {
  try {
    const args = parseArgs(argv);
    const t = target(resolve(args.dir), args.local);
    if (args.command === "inspect") {
      inspect(t);
    } else {
      clear(t, args.fingerprint);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof Stop)) {
      throw error;
    }
    console.error(error.message);
    return error.code;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exit(main(process.argv.slice(2)));
}
