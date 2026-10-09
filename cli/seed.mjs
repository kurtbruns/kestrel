/*
 * `kestrel seed`: load the demo publication into the running local dev server.
 *
 * A thin wrapper around the dev-only `POST /api/dev/seed` route, which exists only on a local
 * dev server: it mints a local admin token from `/api/dev/token`, attaches the images the demo
 * refers to (each image a post shows, from beside it in its bundle under `demo/`, and the
 * logo `publication.md` names), and POSTs. The posts themselves are bundled into the Worker,
 * which does the reset, the render, and the R2 write, so this needs the dev server up and
 * never talks to D1 or R2 directly. The images travel through the running Worker so they land
 * in the same R2 the dev server serves.
 *
 * The target defaults to the port the dev server recorded in this directory
 * (cli/dev-port.mjs); override it with `PORT` or a URL or port argument. Scale the demo list
 * with `--size` (100 / 1k / 10k / 100k, an approximate target) and pin the seeded PRNG with
 * `--seed`. Without `--size`, the curated story-shaped list (~155 subscribers) loads.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, devToken, fail, parseArgs } from "./dev-api.mjs";

// The demo ships beside the CLI, in this repository and in the package.
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
  // The images are the files in `demo/` that the demo refers to, so those files are the only
  // place to change them. The worker parses the posts and front matter for everything else.
  const demoDir = join(root, "demo");
  const frontMatterValue = (text, key) => {
    const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const line = block.split("\n").find((l) => l.startsWith(`${key}:`));
    return line?.slice(key.length + 1).trim() || undefined;
  };
  // `rel` is the file's path under demo/; `name` is what the worker is told it's called.
  const attach = async (field, rel, name, what) => {
    const path = join(demoDir, rel);
    if (!existsSync(path)) {
      console.warn(`[${tag}] no demo/${rel} — seeding without the ${what}.`);
      return;
    }
    const type = CONTENT_TYPE[rel.slice(rel.lastIndexOf("."))] || "application/octet-stream";
    form.append(field, new Blob([await readFile(path)], { type }), name);
  };

  // Each post is a page bundle, `demo/posts/<bundle>/index.md` with its images beside it.
  // Every image the post shows by a bare filename (`![…](kestrel.webp)`) is uploaded as
  // `<bundle>/<file>`, and the worker attaches it to that post (see src/dev/demo.ts).
  const postsDir = join(demoDir, "posts");
  for (const bundle of (await readdir(postsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    const text = await readFile(join(postsDir, bundle, "index.md"), "utf8");
    const shown = new Set();
    for (const [, name] of text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) {
      if (!name.includes("/") && !name.includes(":")) {
        shown.add(name);
      }
    }
    for (const name of shown) {
      await attach(
        "image",
        `posts/${bundle}/${name}`,
        `${bundle}/${name}`,
        `image ${bundle}/${name}`,
      );
    }
  }
  const logo = frontMatterValue(await readFile(join(demoDir, "publication.md"), "utf8"), "logo");
  if (logo) {
    await attach("logo", logo, logo, "logo");
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
      `could not reach ${url}. Is the dev server running?`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) {
    fail(tag, `request failed: ${res.status} ${res.statusText}`, await res.text());
  }
  return res.json();
}

/** `kestrel seed [--size n] [--seed s] [port|url]`. */
export async function seedCommand(argv) {
  const { flags, positional } = parseArgs(argv);
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
    `  deliveries: ${summary.deliveries}  •  images written: ${summary.imagesWritten}  •  logo written: ${summary.logoWritten}`,
  );
  console.log("");
  console.log("  view it:");
  console.log(`    admin editor: ${summary.urls.admin}`);
  for (const a of summary.urls.archive) {
    console.log(`    archived post: ${a}`);
  }
}
