import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { UNSUB_SENTINEL } from "../src/render/render";
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
    const expected = send.rendered_html
      .split(UNSUB_SENTINEL)
      .join("http://localhost:8787/unsubscribe");
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
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Draft Only", markdown: "wip" },
      "test",
    );
    const res = await SELF.fetch(`${base}/newsletter/${post.slug}`);
    expect(res.status).toBe(404);
  });
});
