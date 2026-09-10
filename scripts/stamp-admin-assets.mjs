#!/usr/bin/env node
/*
 * Fingerprint the admin SPA's static assets.
 *
 * The editor ships two hand-authored static files — public/dashboard/styles.css and
 * app.js — referenced from index.html. This stamps each reference with a content
 * fingerprint (`?v=<hash>`, the first 8 hex of the file's SHA-256), so a changed
 * asset lands on a fresh URL and public/_headers can cache the old one immutably.
 * It replaces the hand-bumped `?v=NN`: the hash is derived from the bytes, so it
 * can never be stale-but-same or bumped inconsistently.
 *
 * Modes:
 *   (default)  rewrite index.html in place when the stamps are out of date.
 *   --check    exit non-zero if index.html is out of date (the drift guard; wired
 *              into `pretest` so the quality gate catches an unstamped commit).
 *
 * Pure Node, no dependencies — runs anywhere `npm ci` does. `npm run dev` runs it
 * on startup (scripts/dev.mjs), so a restart re-stamps; run `npm run assets:build`
 * by hand after editing an asset if the dev server isn't restarting.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = join(ROOT, "public", "dashboard");
const INDEX = join(ADMIN_DIR, "index.html");

/** Assets to fingerprint, by the basename referenced in index.html. */
const ASSETS = ["styles.css", "app.js"];

/** Content fingerprint: first 8 hex of the file's SHA-256 (matches sibling projects). */
function assetHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** Replace `./<name>` (with or without an existing `?v=`) with `./<name>?v=<hash>`. */
function stamp(html, name, hash) {
  const escaped = name.replace(/\./g, "\\.");
  const re = new RegExp(`\\./${escaped}(\\?v=[^"']*)?`, "g");
  return html.replace(re, `./${name}?v=${hash}`);
}

async function stampedHtml() {
  let html = await readFile(INDEX, "utf8");
  const stamps = [];
  for (const name of ASSETS) {
    const hash = assetHash(await readFile(join(ADMIN_DIR, name)));
    html = stamp(html, name, hash);
    stamps.push(`${name}=${hash}`);
  }
  return { html, stamps };
}

const check = process.argv.includes("--check");
const current = await readFile(INDEX, "utf8");
const { html, stamps } = await stampedHtml();

if (html === current) {
  console.log("[assets] stamps current");
} else if (check) {
  console.error("[assets] index.html stamps are out of date — run: npm run assets:build");
  process.exit(1);
} else {
  await writeFile(INDEX, html);
  console.log(`[assets] stamped  ${stamps.join("  ")}`);
}
