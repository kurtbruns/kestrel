#!/usr/bin/env node
/*
 * Load the local "Field Notes" demo dataset into the running dev server.
 *
 * This is a thin wrapper around the dev-only `POST /api/dev/seed` route (fake
 * transport only): it mints a local admin token from `/api/dev/token`, attaches the
 * cover photo from `scripts/seed-assets/kestrel.jpg` if present, and POSTs. The
 * worker itself does the reset, the render, and the R2 write — so this needs the
 * dev server up (`npm run dev`), and it never talks to D1/R2 directly.
 *
 * The image travels through the running worker (not an out-of-band `wrangler r2
 * object put`) so it lands in the same R2 the dev server serves, with no stale
 * read. The target defaults to the port `npm run dev` recorded for this worktree
 * (scripts/dev-port.mjs), so a worktree on a non-8787 port just works; override it
 * with `PORT` or a URL argument: `npm run seed -- 8788`.
 *
 * Scale the demo list with `--size` (100 / 1k / 10k / 100k, an approximate target)
 * and pin the seeded PRNG with `--seed`: `npm run seed -- --size 10k`. Without
 * `--size`, the curated story-shaped list (~155 subscribers) loads unchanged.
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, devToken, fail, parseArgs } from "./dev-api.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reset the dev server's database and load the demo, with its cover image and logo, as
 * `token`. `size` and `seed` scale the list as `--size` and `--seed` do. Resolves the
 * worker's summary, or exits saying why it couldn't.
 */
export async function seedDemo(base, token, { size, seed } = {}, tag = "seed") {
  const params = new URLSearchParams();
  if (size) {
    params.set("size", size);
  }
  if (seed) {
    params.set("seed", seed);
  }
  const qs = params.toString();
  const url = `${base}/api/dev/seed${qs ? `?${qs}` : ""}`;

  const form = new FormData();
  const CONTENT_TYPE = {
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
  };
  const coverDir = join(root, "scripts", "seed-assets");
  const coverName = [".webp", ".jpg", ".jpeg", ".png", ".gif"]
    .map((ext) => `kestrel${ext}`)
    .find((name) => existsSync(join(coverDir, name)));
  if (coverName) {
    const bytes = await readFile(join(coverDir, coverName));
    const type =
      CONTENT_TYPE[coverName.slice(coverName.lastIndexOf("."))] || "application/octet-stream";
    form.set("kestrel", new Blob([bytes], { type }), coverName);
  } else {
    console.warn(
      `[${tag}] no scripts/seed-assets/kestrel.{webp,jpg,jpeg,png,gif} found — seeding without the cover image.\n` +
        "        Drop the kestrel photo there and re-run `npm run seed` to fill it in.",
    );
  }

  // The publication logo. Committed (unlike the cover photo), so it normally just
  // rides along; the worker writes it to R2 and records the branding metadata.
  const logoPath = join(coverDir, "windbreak-logo.svg");
  if (existsSync(logoPath)) {
    const bytes = await readFile(logoPath);
    form.set("logo", new Blob([bytes], { type: "image/svg+xml" }), "windbreak-logo.svg");
  } else {
    console.warn(`[${tag}] no scripts/seed-assets/windbreak-logo.svg — seeding without the logo.`);
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    fail(
      tag,
      `could not reach ${url}. Is the dev server running? (npm run dev)`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) {
    fail(tag, `request failed: ${res.status} ${res.statusText}`, await res.text());
  }
  return res.json();
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const base = baseUrl(positional[0]);
  const token = await devToken(base, "seed");
  const summary = await seedDemo(base, token, { size: flags.size, seed: flags.seed });
  console.log("[seed] done:");
  if (flags.size) {
    console.log(`  size: ~${flags.size} requested (approximate; PRNG-seeded)`);
  }
  console.log(
    `  subscribers: ${summary.subscribers.confirmed} confirmed, ${summary.subscribers.pending} pending, ${summary.subscribers.unsubscribed} unsubscribed`,
  );
  console.log(`  suppressions: ${summary.suppressions}  •  audience: ${summary.audience}`);
  console.log(
    `  posts: ${summary.posts.sent} sent, ${summary.posts.scheduled} scheduled, ${summary.posts.draft} draft`,
  );
  console.log(
    `  deliveries: ${summary.deliveries}  •  cover image written: ${summary.coverImageBytesWritten}  •  logo written: ${summary.logoWritten}`,
  );
  console.log("");
  console.log("  view it:");
  console.log(`    admin editor: ${summary.urls.admin}`);
  for (const a of summary.urls.archive) {
    console.log(`    archived post: ${a}`);
  }
}

/** Whether this file is the script node was asked to run. Compared as real paths: node
 *  resolves symlinks for the module's own URL but keeps argv as typed, so a script run
 *  through a symlinked path (`/tmp` on macOS) would otherwise never match. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // no script path (a REPL, `node -e`): imported, not run
  }
}

// Run when invoked (`npm run seed`); `simulate-send` imports `seedDemo` instead.
if (invokedDirectly()) {
  main();
}
