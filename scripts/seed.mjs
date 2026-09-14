#!/usr/bin/env node
import { existsSync } from "node:fs";
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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDevPort } from "./dev-port.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Split argv into `--flag value` / `--flag=value` pairs and bare positionals, so the
 *  base URL / port positional and the scale flags can be given in any order. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^--([^=]+)=(.*)$/.exec(a);
    if (eq) {
      flags[eq[1]] = eq[2];
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function baseUrl(positional) {
  const arg = positional[0];
  if (arg) {
    return /^https?:\/\//.test(arg) ? arg : `http://localhost:${arg}`;
  }
  const port = process.env.PORT || readDevPort() || "8787";
  return `http://localhost:${port}`;
}

// Mint a local admin token from the dev-only bootstrap endpoint — the same one the
// editor uses. Needs no `.dev.vars`; it 404s on any non-dev transport.
async function devToken(base) {
  let res;
  try {
    res = await fetch(`${base}/api/dev/token?kind=service`);
  } catch (err) {
    console.error(`[seed] could not reach ${base}. Is the dev server running? (npm run dev)`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(
      "[seed] /api/dev/token is unavailable — seeding only works under the fake transport.",
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[seed] could not mint a dev token: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  return (await res.json()).token;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const base = baseUrl(positional);
  const params = new URLSearchParams();
  if (flags.size) {
    params.set("size", flags.size);
  }
  if (flags.seed) {
    params.set("seed", flags.seed);
  }
  const qs = params.toString();
  const url = `${base}/api/dev/seed${qs ? `?${qs}` : ""}`;
  const token = await devToken(base);

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
      "[seed] no scripts/seed-assets/kestrel.{webp,jpg,jpeg,png,gif} found — seeding without the cover image.\n" +
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
    console.warn("[seed] no scripts/seed-assets/windbreak-logo.svg — seeding without the logo.");
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    console.error(`[seed] could not reach ${url}. Is the dev server running? (npm run dev)`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`[seed] request failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const summary = await res.json();
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
    console.log(`    archived issue: ${a}`);
  }
}

main();
