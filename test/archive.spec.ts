import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/env";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { clearFakeOutbox } from "../src/providers/fake";
import { UNSUB_SENTINEL } from "../src/render/render";

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
    "INSERT INTO subscribers (id, email, status, token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','tok-a',?,?)",
  )
    .bind(now, now)
    .run();
  const { post } = await posts.createPost(env.DB, { subject: title, markdown }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

describe("archive / view-in-browser", () => {
  it("serves the frozen render verbatim, sentinel substituted (I3)", async () => {
    const post = await sendPost("Archive Me", "# Hello\n\nthe permanent record");
    const send = (await latestSentSendForPost(env.DB, post.id))!;

    const res = await SELF.fetch(`${base}/newsletter/${post.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    const expected = send.rendered_html.split(UNSUB_SENTINEL).join("http://localhost:8787/unsubscribe");
    expect(body).toBe(expected); // byte-identical to the frozen record
    expect(body).not.toContain(UNSUB_SENTINEL);
    expect(body).toContain("the permanent record");
    expect(body).toContain("/unsubscribe");
  });

  it("404s for an unknown slug", async () => {
    const res = await SELF.fetch(`${base}/newsletter/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("404s for a post that hasn't been sent yet", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Draft Only", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/newsletter/${post.slug}`);
    expect(res.status).toBe(404);
  });
});

describe("archive index (the public front door, §10)", () => {
  async function ensureSubscriber(): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscribers (id, email, status, token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','tok-a',?,?)",
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
    await env.DB.prepare("UPDATE sends SET completed_at = ? WHERE post_id = ?").bind(completedAt, post.id).run();
    return post;
  }

  it("lists sent issues newest-first, linking to their canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    expect(body).toContain("The Older One");
    expect(body).toContain("The Newer One");
    expect(body).toContain(`http://localhost:8787/newsletter/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/newsletter/${older.slug}`);
    // Newest first.
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("never links into the Access-gated admin surface", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    expect(body).not.toContain("/admin");
  });

  it("shows an empty state and excludes drafts / scheduled posts", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No issues yet.");
    expect(body).not.toContain("Just A Draft");
  });
});
