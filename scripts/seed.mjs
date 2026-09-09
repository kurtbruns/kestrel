#!/usr/bin/env node
import { existsSync } from "node:fs";
/*
 * Load the local "Field Notes" demo dataset into the running dev server.
 *
 * This is a thin wrapper around the dev-only `POST /api/dev/seed` route (fake
 * transport only): it reads the admin BEARER_TOKEN from `.dev.vars`, attaches the
 * cover photo from `scripts/seed-assets/kestrel.jpg` if present, and POSTs. The
 * worker itself does the reset, the render, and the R2 write — so this needs the
 * dev server up (`npm run dev`), and it never talks to D1/R2 directly.
 *
 * The image travels through the running worker (not an out-of-band `wrangler r2
 * object put`) so it lands in the same R2 the dev server serves, with no stale
 * read. Override the target with `PORT` or a URL argument: `npm run seed -- 8788`.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function baseUrl() {
  const arg = process.argv[2];
  if (arg) {
    return /^https?:\/\//.test(arg) ? arg : `http://localhost:${arg}`;
  }
  const port = process.env.PORT || "8787";
  return `http://localhost:${port}`;
}

async function bearerToken() {
  const path = join(root, ".dev.vars");
  if (!existsSync(path)) {
    console.error(
      "[seed] .dev.vars not found. Copy .dev.vars.example to .dev.vars and set BEARER_TOKEN.",
    );
    process.exit(1);
  }
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*BEARER_TOKEN\s*=\s*(.*)\s*$/);
    if (m) {
      return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  console.error("[seed] BEARER_TOKEN is not set in .dev.vars.");
  process.exit(1);
}

async function main() {
  const url = `${baseUrl()}/api/dev/seed`;
  const token = await bearerToken();

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
  console.log(
    `  subscribers: ${summary.subscribers.confirmed} confirmed, ${summary.subscribers.pending} pending, ${summary.subscribers.unsubscribed} unsubscribed`,
  );
  console.log(`  suppressions: ${summary.suppressions}  •  audience: ${summary.audience}`);
  console.log(
    `  posts: ${summary.posts.sent} sent, ${summary.posts.scheduled} scheduled, ${summary.posts.draft} draft`,
  );
  console.log(
    `  deliveries: ${summary.deliveries}  •  cover image written: ${summary.coverImageBytesWritten}`,
  );
  console.log("");
  console.log("  view it:");
  console.log(`    admin editor: ${summary.urls.admin}`);
  for (const a of summary.urls.archive) {
    console.log(`    archived issue: ${a}`);
  }
}

main();
