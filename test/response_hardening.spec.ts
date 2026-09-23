import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { getConfig } from "../src/env";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { adminAuth } from "./support/auth";

// The response headers that keep post content from running script on the app's own
// origin, keep the pages from being framed, and keep admin responses out of caches.

const AUTH = await adminAuth();
const base = "https://kestrel.test";

/** The page carries the strict policy: no script, no framing (SPEC §5). */
function expectHardenedPage(res: Response): void {
  const csp = res.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    expect(csp).toContain(directive);
  }
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

async function sentPost(title: string, markdown: string): Promise<posts.PostRow> {
  const { post } = await posts.createPost(env.DB, { subject: title, markdown }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

describe("reader and preview pages", () => {
  it("serve a post page under the strict policy, whatever HTML the post carries", async () => {
    const post = await sentPost(
      "Hardened",
      '# Hi\n\n<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    );
    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(200);
    expectHardenedPage(res);
    // The page's own needs are allowed: the display font and images from any origin.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).toContain("img-src * data:");
    // A form in the post's body can't submit: it would carry the publisher's session to
    // the admin API on this same origin.
    expect(csp).toContain("form-action 'none'");
  });

  it("serve the landing page, the archive index, a not-found post, and the subscribe pages the same way", async () => {
    for (const path of ["/", "/archive", "/archive/no-such-post", "/unsubscribe?token=nope"]) {
      const res = await SELF.fetch(`${base}${path}`, { headers: { accept: "text/html" } });
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expectHardenedPage(res);
      // The app's own forms (subscribe, unsubscribe) post back to it.
      expect(res.headers.get("content-security-policy"), path).toContain("form-action 'self'");
    }
  });

  it("serve the publisher's preview the same way, and never let it be stored", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Preview", markdown: "# Hi" }, "t");
    const res = await SELF.fetch(`${base}/posts/${post.id}/preview`, { headers: AUTH });
    expect(res.status).toBe(200);
    expectHardenedPage(res);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("admin responses", () => {
  it("are no-store: JSON, an error, and the gate's own 401", async () => {
    const ok = await SELF.fetch(`${base}/api/settings`, { headers: AUTH });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const missing = await SELF.fetch(`${base}/posts/no-such-post`, { headers: AUTH });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const denied = await SELF.fetch(`${base}/api/settings`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });

  it("leave a public response's caching as it was", async () => {
    const res = await SELF.fetch(`${base}/archive`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
