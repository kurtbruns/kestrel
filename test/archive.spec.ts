import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { ARCHIVE_MASTHEAD_ANCHOR, UNSUB_SENTINEL } from "../src/render/render";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";

const base = "https://kestrel.test";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
  clearFakeOutbox();
});

async function sendPost(title: string, markdown: string): Promise<posts.PostRow> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','cfm-a','uns-a',?,?)",
  )
    .bind(now, now)
    .run();
  const { post } = await posts.createPost(env.DB, { subject: title, markdown }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

describe("archive / view-in-browser", () => {
  it("serves the frozen content unchanged, with the sentinel and masthead anchor substituted (I3)", async () => {
    const post = await sendPost("Archive Me", "# Hello\n\nthe permanent record");
    const send = (await latestSentSendForPost(env.DB, post.id))!;
    // The sent/frozen record is masthead-free: the anchor is inert, no chrome baked in.
    expect(send.rendered_html).toContain(ARCHIVE_MASTHEAD_ANCHOR);
    expect(send.rendered_html).not.toContain('class="k-mast"');

    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    // Reviewed content is served unchanged.
    expect(body).toContain("<h1>Hello</h1>");
    expect(body).toContain("the permanent record");
    // The unsubscribe sentinel is substituted for a generic link.
    expect(body).not.toContain(UNSUB_SENTINEL);
    expect(body).toContain("/unsubscribe");
    // The browser-only masthead replaces its inert anchor and links back to the index.
    expect(body).not.toContain(ARCHIVE_MASTHEAD_ANCHOR);
    expect(body).toContain('class="k-mast"');
    expect(body).toContain('href="http://localhost:8787/"');
  });

  it("404s for an unknown slug", async () => {
    const res = await SELF.fetch(`${base}/archive/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("404s for a post that hasn't been sent yet", async () => {
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Draft Only", markdown: "wip" },
      "test",
    );
    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(404);
  });
});

async function ensureSubscriber(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','cfm-a','uns-a',?,?)",
  )
    .bind(now, now)
    .run();
}

async function publish(subject: string, completedAt: number): Promise<posts.PostRow> {
  await ensureSubscriber();
  const { post } = await posts.createPost(env.DB, { subject, markdown: `# ${subject}` }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  // Pin completed_at so ordering is deterministic (sweep uses wall-clock ms).
  await env.DB.prepare("UPDATE sends SET completed_at = ? WHERE post_id = ?")
    .bind(completedAt, post.id)
    .run();
  return post;
}

describe("landing page (the public front door, §5)", () => {
  it("features the latest issue over the recent ones, linking to canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    // The newest is the feature; the older sits in the recent list. Both link out.
    expect(body).toContain("Latest issue");
    expect(body).toContain("The Newer One");
    expect(body).toContain("The Older One");
    expect(body).toContain(`http://localhost:8787/archive/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/archive/${older.slug}`);
    // The feature (newest) precedes the recent list (older).
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("offers a subscribe call to action and a link into the full archive", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    expect(body).toContain("Subscribe here");
    expect(body).toContain('href="http://localhost:8787/subscribe"');
    expect(body).toContain("Browse the full archive");
    expect(body).toContain('href="http://localhost:8787/archive"');
  });

  it("never links into the Access-gated admin surface", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    // The admin SPA lives at /dashboard; the public front door must never link into it (SPEC §10).
    expect(body).not.toContain("/dashboard");
  });

  it("shows an empty state when nothing has been sent", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No issues yet");
    expect(body).not.toContain("Just A Draft");
  });
});

describe("archive index (the full list, §5)", () => {
  it("lists every sent issue newest-first, linking to their canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    expect(body).toContain("The Older One");
    expect(body).toContain("The Newer One");
    expect(body).toContain(`http://localhost:8787/archive/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/archive/${older.slug}`);
    // Newest first.
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("never links into the Access-gated admin surface", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/archive`)).text();
    expect(body).not.toContain("/dashboard");
  });

  it("shows an empty state and excludes drafts / scheduled posts", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/archive`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No issues yet.");
    expect(body).not.toContain("Just A Draft");
  });
});
