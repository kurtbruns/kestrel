import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlistedPostUrl } from "../shared/archive_url";
import * as images from "../src/db/images";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { Budget } from "../src/send/budget";
import { runSend } from "../src/send/loop";
import { cancel, freeze } from "../src/send/schedule";
import { removeUnusedImages } from "../src/send/unused_images";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { base, PNG_1x1 } from "./support/http";
import { logged } from "./support/log";

// What a send does with its post's uploaded images when it first goes out (SPEC §4, §6): the
// images the body uses stay, every other one is deleted, row and object, and the frozen email
// and the post's page still show every image they show (I3).

const config = () => getConfig(env);

/** A draft whose body is `markdown`, with each named image uploaded to it, row and bytes. */
async function postWithImages(markdown: string, names: string[]): Promise<posts.PostRow> {
  const { post } = await posts.createPost(env.DB, { subject: "Birds", markdown }, "test");
  for (const filename of names) {
    const row = await images.insertImageIfNameFree(env.DB, {
      postId: post.id,
      filename,
      storageKey: `posts/${post.id}/${filename}`,
      contentType: "image/png",
      width: 1,
      height: 1,
    });
    await env.MEDIA.put(`posts/${post.id}/${filename}`, PNG_1x1);
    expect(row?.filename).toBe(filename);
  }
  return post;
}

/** The post's image names as stored, and which of their objects R2 still holds. */
async function stored(postId: string): Promise<{ rows: string[]; objects: string[] }> {
  const rows = (await images.listImages(env.DB, postId)).map((r) => r.filename);
  const listed = await env.MEDIA.list({ prefix: `posts/${postId}/` });
  const objects = listed.objects.map((o) => o.key.slice(`posts/${postId}/`.length)).sort();
  return { rows, objects };
}

/** Every address under `/media/` in a page's HTML. */
function mediaAddresses(html: string): string[] {
  return [...html.matchAll(/https?:\/\/[^"'\s)]*\/media\/posts\/[^"'\s)]+/g)].map((m) =>
    m[0].replace(/&amp;/g, "&"),
  );
}

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  const all = await env.MEDIA.list({ prefix: "posts/" });
  if (all.objects.length > 0) {
    await env.MEDIA.delete(all.objects.map((o) => o.key));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a send's unused images (SPEC §4)", () => {
  it("deletes, when the send first goes out, every image the body doesn't use, and keeps the rest", async () => {
    await seedConfirmed("reader@example.com");
    const media = config().mediaPublicBase;
    const markdown = [
      "![A heron](heron.png)",
      "[The egret, full size](egret.png)", // a bare name in a link reaches nothing, so unused
      `[The ibis, full size](${media}/posts/POST/ibis.png)`,
      `<img src="${media}/posts/POST/old%20crane.png" alt="An old crane">`,
      `<p><img src="${media}/posts/POST/kite&amp;hawk.png" alt="A pair"></p>`,
    ].join("\n\n");
    const post = await postWithImages("draft", [
      "heron.png",
      "egret.png",
      "ibis.png",
      "old crane.png",
      "kite&hawk.png",
      "dropped.png",
    ]);
    const saved = await posts.updatePost(
      env.DB,
      post,
      { markdown: markdown.replaceAll("POST", post.id) },
      "test",
    );
    const send = await freeze(env, config(), saved?.post ?? post, Date.now() - 1000);

    const result = await runSend(env, send.id);

    expect(result.finished).toBe(true);
    const kept = ["heron.png", "ibis.png", "kite&hawk.png", "old crane.png"];
    expect(await stored(post.id)).toEqual({ rows: kept, objects: kept });
  });

  it("leaves every image the sent email and the post's page show still served (I3)", async () => {
    await seedConfirmed("reader@example.com");
    const media = config().mediaPublicBase;
    const post = await postWithImages("draft", ["heron.png", "old crane.png", "dropped.png"]);
    const markdown = [
      "![A heron](heron.png)",
      `<img src="${media}/posts/${post.id}/old%20crane.png" alt="An old crane">`,
    ].join("\n\n");
    const saved = await posts.updatePost(env.DB, post, { markdown }, "test");
    const send = await freeze(env, config(), saved?.post ?? post, Date.now() - 1000);

    await runSend(env, send.id);

    const sent = await sends.getSend(env.DB, send.id);
    const page = await SELF.fetch(unlistedPostUrl(base, post.unlisted_token));
    expect(page.status).toBe(200);
    for (const html of [sent?.rendered_html ?? "", await page.text()]) {
      const addresses = mediaAddresses(html);
      expect(addresses).toHaveLength(2);
      for (const address of addresses) {
        const served = await SELF.fetch(`${base}${new URL(address).pathname}`);
        expect(served.status, address).toBe(200);
      }
    }
    expect((await stored(post.id)).rows).toEqual(["heron.png", "old crane.png"]);
  });

  it("deletes nothing at schedule, nor from a send canceled before it fires", async () => {
    const post = await postWithImages("Just words", ["dropped.png"]);
    const send = await freeze(env, config(), post, Date.now() + 3_600_000);
    expect(await stored(post.id)).toEqual({ rows: ["dropped.png"], objects: ["dropped.png"] });

    await cancel(env, send.id);
    await runSend(env, send.id);

    expect(await stored(post.id)).toEqual({ rows: ["dropped.png"], objects: ["dropped.png"] });
  });

  it("deletes nothing on a later run, once the audience is fixed (SPEC §6)", async () => {
    await seedConfirmed("reader@example.com");
    const post = await postWithImages("Just words", ["dropped.png"]);
    const send = await freeze(env, config(), post, Date.now() - 1000);
    // Started and its audience fixed by an earlier run, which left the image (a failed delete).
    await env.DB.prepare(
      "UPDATE sends SET status = 'sending', started_at = ?, audience_resolved_at = ? WHERE id = ?",
    )
      .bind(Date.now(), Date.now(), send.id)
      .run();

    await runSend(env, send.id);

    expect(await stored(post.id)).toEqual({ rows: ["dropped.png"], objects: ["dropped.png"] });
  });

  it("is safe to run twice: the second finds nothing to delete", async () => {
    const post = await postWithImages("Just words", ["dropped.png"]);
    const send = await freeze(env, config(), post, Date.now() - 1000);
    const info = vi.spyOn(console, "log");
    const budget = new Budget(1000);

    await removeUnusedImages(env, env.DB, budget, send, config().mediaPublicBase);
    await removeUnusedImages(env, env.DB, budget, send, config().mediaPublicBase);

    expect(await stored(post.id)).toEqual({ rows: [], objects: [] });
    const removed = logged(info).filter((l) => l.event === "send.images_removed");
    expect(removed).toEqual([expect.objectContaining({ sendId: send.id, count: 1 })]);
  });

  it("still sends when the delete fails, and leaves the images, row and object, with a warning", async () => {
    await seedConfirmed("reader@example.com");
    const post = await postWithImages("Just words", ["dropped.png"]);
    const send = await freeze(env, config(), post, Date.now() - 1000);
    vi.spyOn(env.MEDIA, "delete").mockRejectedValue(new Error("R2 is down"));
    const warn = vi.spyOn(console, "warn");

    const result = await runSend(env, send.id);

    expect(result.finished).toBe(true);
    expect(result.accepted).toBe(1);
    expect(await stored(post.id)).toEqual({ rows: ["dropped.png"], objects: ["dropped.png"] });
    expect(logged(warn)).toContainEqual(
      expect.objectContaining({
        event: "send.images_unremoved",
        sendId: send.id,
        postId: post.id,
        count: 1,
      }),
    );
  });
});
