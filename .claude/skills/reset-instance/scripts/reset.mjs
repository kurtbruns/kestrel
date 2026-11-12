#!/usr/bin/env node
// The maintainer's reset, run against one instance's repository through its own wrangler:
// `inspect` reads the instance and prints what a reset would delete and what the maintainer
// has to say yes to, and `clear` does it, only for the state `inspect` showed. What is cleared,
// kept, and refused is plan.mjs; SKILL.md says when each command runs and what the person is
// asked. Plain Node, no dependency but the instance's wrangler.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLEARED, clearSql, judge, KEPT, QUERIES } from "./plan.mjs";

const USAGE = `usage:
  reset.mjs inspect <instance-dir> [--local]
  reset.mjs clear   <instance-dir> --fingerprint <value from inspect> [--local]

Without --local it acts on the instance's production environment (--remote --env production).
With --local it acts on the local database and bucket \`wrangler dev\` uses in that directory.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** JSON with comments and trailing commas, as wrangler.jsonc is written. */
function parseJsonc(text) {
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
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Where the instance's data lives, read from its wrangler.jsonc: production's, or with
 *  `--local` the development environment's. */
function target(dir, local) {
  const path = join(dir, "wrangler.jsonc");
  if (!existsSync(path)) {
    fail(`${dir} has no wrangler.jsonc, so it isn't an instance's repository.`);
  }
  const config = parseJsonc(readFileSync(path, "utf8"));
  const env = local ? config : config.env?.production;
  if (!env) {
    fail(`${path} declares no production environment.`);
  }
  const database = env.d1_databases?.find((d) => d.binding === "DB");
  const bucket = env.r2_buckets?.find((b) => b.binding === "MEDIA");
  if (!database || !bucket) {
    fail(`${path} doesn't declare the DB database and the MEDIA bucket for this environment.`);
  }
  const wrangler = join(dir, "node_modules", ".bin", "wrangler");
  if (!existsSync(wrangler)) {
    fail(`${dir} has no wrangler installed. Run \`npm install\` there first.`);
  }
  return {
    dir,
    local,
    wrangler,
    where: local ? ["--local"] : ["--remote", "--env", "production"],
    environment: local ? "local development" : "production",
    origin: env.vars?.APP_ORIGIN ?? "(no APP_ORIGIN)",
    database: database.database_name,
    bucket: bucket.bucket_name,
  };
}

function wrangler(t, args) {
  return execFileSync(t.wrangler, args, {
    cwd: t.dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** One SELECT's rows. A remote `--file` run prints no rows, so every read is a `--command`. */
function rows(t, sql) {
  const out = wrangler(t, ["d1", "execute", "DB", ...t.where, "--json", "--command", sql]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) {
    throw new Error(`wrangler answered without rows for: ${sql}\n${out}`);
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

function fingerprintOf(t, verdict) {
  return createHash("sha256")
    .update(JSON.stringify([t.environment, t.database, t.bucket, verdict.fingerprint]))
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

function printRefusals(refusals) {
  console.log("\nREFUSED. Nothing was changed, and nothing here may be worked around:");
  for (const r of refusals) {
    console.log(`  - ${r}`);
  }
}

function inspect(t) {
  const verdict = readAll(t);
  printInstance(t, verdict.toName);
  if (verdict.refusals.length > 0) {
    printRefusals(verdict.refusals);
    process.exit(2);
  }
  const n = verdict.toName;

  console.log("\nWho wrote and acted here");
  console.log(
    `  ${n.author ?? "no person"}${n.serviceActed ? ", and a service token" : ""}${n.author ? "" : " (no revision, act, or import by a person)"}`,
  );

  console.log(`\nAddresses that aren't test recipients (${n.addresses.length})`);
  for (const a of n.addresses) {
    console.log(`  ${a.email}: ${a.what}`);
  }
  if (n.addresses.length === 0) {
    console.log("  none");
  }
  if (n.erased > 0) {
    console.log(`  plus ${n.erased} erased subscriber(s), whose do-not-contact record goes too`);
  }
  if (n.pending > 0) {
    console.log(`  plus ${n.pending} pending signup(s), never confirmed, not listed`);
  }

  console.log(`\nSent posts, whose record nothing else can delete (${n.sent.length})`);
  for (const s of n.sent) {
    console.log(
      `  "${s.subject}", ${day(s.fireAt)}, mailed to ${s.recipients}, ${s.listed ? "LISTED in the public archive" : "email only"}`,
    );
  }
  if (n.sent.length === 0) {
    console.log("  none");
  }

  console.log("\nWhat a reset deletes");
  for (const table of CLEARED) {
    console.log(`  ${table}: ${n.counts[table]}`);
  }
  console.log(`  post images in the bucket: ${n.images.length}`);
  console.log("\nWhat it keeps");
  console.log(
    `  settings (name, template, time zone ${n.publication?.time_zone ?? "not set"}, notification addresses, ${n.publication?.test_recipients ?? 0} test recipient(s)), the sending and provider_account rows, and logos in the bucket`,
  );
  if (n.refusedByProvider.length > 0) {
    console.log("\nThe provider's own suppression list is left alone, and may still refuse");
    for (const email of n.refusedByProvider) {
      console.log(`  ${email}`);
    }
  }
  console.log(`\nfingerprint: ${fingerprintOf(t, verdict)}`);
}

function bookmark(t) {
  if (t.local) {
    return null;
  }
  const out = wrangler(t, ["d1", "time-travel", "info", "DB", "--env", "production", "--json"]);
  const found = JSON.parse(out.slice(out.indexOf("{"))).bookmark;
  if (typeof found !== "string" || found === "") {
    fail(`No restore point could be read, so nothing was changed.\n${out}`);
  }
  return found;
}

function clear(t, expected) {
  const verdict = readAll(t);
  printInstance(t, verdict.toName);
  if (verdict.refusals.length > 0) {
    printRefusals(verdict.refusals);
    process.exit(2);
  }
  const fingerprint = fingerprintOf(t, verdict);
  if (fingerprint !== expected) {
    fail(
      `\nREFUSED. The instance is not as it was when it was inspected (fingerprint ${fingerprint}, not ${expected}). Nothing was changed. Inspect it again and show the person what is there now.`,
    );
  }
  const before = verdict.toName;
  const restorePoint = bookmark(t);
  const startedAt = new Date().toISOString();

  const scratch = mkdtempSync(join(tmpdir(), "kestrel-reset-"));
  try {
    const file = join(scratch, "clear.sql");
    writeFileSync(file, clearSql());
    wrangler(t, ["d1", "execute", "DB", ...t.where, "--yes", "--file", file]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Read back: a remote file run prints no rows, and Cloudflare doesn't promise it is atomic.
  const after = rows(t, QUERIES.counts)[0];
  const left = CLEARED.filter((table) => after[table] !== 0);
  const moved = KEPT.filter((table) => after[table] !== before.counts[table]);
  if (left.length > 0) {
    fail(
      `\nThe clear stopped partway: ${left.join(", ")} still hold rows. No image was deleted. Inspect again and run the clear again; it is safe to repeat.${restorePoint ? `\nRestore point from before it: ${restorePoint}` : ""}`,
    );
  }

  const failed = [];
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
      failed.push(
        `${key}: ${String(error.stderr || error.message)
          .trim()
          .split("\n")
          .pop()}`,
      );
    }
  }

  console.log("\nRESET DONE");
  console.log(`  when:        ${startedAt}`);
  for (const table of CLEARED) {
    if (before.counts[table] > 0) {
      console.log(`  deleted:     ${before.counts[table]} from ${table}`);
    }
  }
  console.log(
    `  images:      ${before.images.length - failed.length} of ${before.images.length} deleted from ${t.bucket}`,
  );
  for (const line of failed) {
    console.log(`  NOT deleted: ${line}`);
  }
  console.log(
    `  kept:        ${KEPT.map((table) => `${table} (${after[table]} row)`).join(", ")}${moved.length ? `; ${moved.join(", ")} changed while this ran, by the app` : ""}`,
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
  if (failed.length > 0) {
    process.exit(3);
  }
}

const args = process.argv.slice(2);
const command = args[0];
const local = args.includes("--local");
const at = args.indexOf("--fingerprint");
const fingerprint = at === -1 ? null : args[at + 1];
const dir = args
  .slice(1)
  .find((a, i, rest) => !a.startsWith("--") && rest[i - 1] !== "--fingerprint");

if (!dir || (command !== "inspect" && command !== "clear")) {
  fail(USAGE);
}
const t = target(resolve(dir), local);
if (command === "inspect") {
  inspect(t);
} else {
  if (!fingerprint) {
    fail(`clear needs the fingerprint inspect printed.\n\n${USAGE}`);
  }
  clear(t, fingerprint);
}
