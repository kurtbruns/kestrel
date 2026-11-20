/**
 * The archive's feed (SPEC §5): the posts the archive index lists, newest first, each in full
 * as HTML from the send's frozen web copy, which the one render made beside the email (I3, I5).
 */
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { getSend } from "../src/db/sends";
import { plainTextAsHtml } from "../src/lib/feed";
import { clearFakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import {
  dueSend,
  frozenSend,
  resetDatabase,
  seedConfirmed,
  sendingWorks,
  setRow,
} from "./support/fixtures";
import { base } from "./support/http";

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  clearFakeOutbox();
  await seedConfirmed("a@example.com");
});

/** A post sent through the sweep, its send's id and post. */
async function sendPost(subject: string, markdown: string) {
  const send = await dueSend({ subject, markdown });
  await sweep(env);
  return { sendId: send.id, post: (await posts.getPost(env.DB, send.post_id))! };
}

async function readFeed(): Promise<{ res: Response; xml: string }> {
  const res = await SELF.fetch(`${base}/archive/feed.xml`);
  return { res, xml: await res.text() };
}

/** Each item's title, in the order the feed gives them. */
function titles(xml: string): string[] {
  return [...xml.matchAll(/<item><title>([^<]*)<\/title>/g)].map((m) => m[1]!);
}

describe("the archive's feed (§5)", () => {
  it("is an RSS document naming the publication and itself, with no items before a post is sent", async () => {
    const { res, xml } = await readFeed();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<link>http://localhost:8787/archive</link>");
    expect(xml).toContain(
      '<atom:link href="http://localhost:8787/archive/feed.xml" rel="self" type="application/rss+xml"/>',
    );
    expect(titles(xml)).toEqual([]);
  });

  it("carries each sent post in full as HTML, the post's own content and not the email around it (I3, I5)", async () => {
    const { sendId, post } = await sendPost(
      "Spring update",
      "# Spring update\n\nThe garden is **blooming** & so is [the list](https://example.com/list).",
    );
    const send = (await getSend(env.DB, sendId))!;
    const { xml } = await readFeed();

    expect(xml).toContain(`<link>http://localhost:8787/archive/${post.slug}</link>`);
    expect(xml).toContain(
      `<guid isPermaLink="true">http://localhost:8787/archive/${post.slug}</guid>`,
    );
    expect(xml).toContain(`<pubDate>${new Date(send.started_at!).toUTCString()}</pubDate>`);
    // The summary its post page gives search engines.
    expect(xml).toContain(
      "<description>The garden is blooming &amp; so is the list.</description>",
    );
    // The full post, escaped once as XML text: the frozen web copy, exactly.
    const content = xml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)![1]!;
    const unescaped = content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(unescaped).toBe(send.rendered_web);
    expect(unescaped).toContain("<strong>blooming</strong>");
    expect(unescaped).toContain('<a href="https://example.com/list">the list</a>');
    // None of the email: no layout, no delivery slot, no footer.
    expect(unescaped).not.toContain("<table");
    expect(unescaped).not.toContain("%%");
    expect(unescaped).not.toContain("Unsubscribe");
  });

  it("lists exactly what the archive index lists, newest first: no email-only or unsent post", async () => {
    const older = await sendPost("Older", "first");
    const newer = await sendPost("Newer", "second");
    const hidden = await sendPost("Hidden", "third");
    await frozenSend(Date.now() + 3_600_000, { subject: "Scheduled" });
    await setRow(older.sendId, { started_at: Date.now() - 2_000 });
    await setRow(newer.sendId, { started_at: Date.now() - 1_000 });
    await env.DB.prepare("UPDATE posts SET email_only = 1 WHERE id = ?").bind(hidden.post.id).run();

    expect(titles((await readFeed()).xml)).toEqual(["Newer", "Older"]);

    // Listed again, it is back in the feed at its publish date.
    await env.DB.prepare("UPDATE posts SET email_only = 0 WHERE id = ?").bind(hidden.post.id).run();
    expect(titles((await readFeed()).xml)).toEqual(["Hidden", "Newer", "Older"]);
  });

  it("gives a send frozen before the web copy was kept its frozen plain text, footer cut (I3)", async () => {
    const { sendId } = await sendPost("Old post", "First paragraph.\n\nSecond: 5 < 6 & more.");
    await setRow(sendId, { rendered_web: null });
    const { xml } = await readFeed();
    const content = xml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)![1]!;
    expect(content).toBe(
      "&lt;p&gt;First paragraph.&lt;/p&gt;\n&lt;p&gt;Second: 5 &amp;lt; 6 &amp;amp; more.&lt;/p&gt;",
    );
  });

  it("drops characters XML forbids, so one stray control character can't break the feed", async () => {
    await sendPost("Bell\u0007 rings", "text");
    expect(titles((await readFeed()).xml)).toEqual(["Bell rings"]);
  });
});

describe("the reader pages advertise the feed (§5)", () => {
  const link =
    '<link rel="alternate" type="application/rss+xml" title="Archive" href="http://localhost:8787/archive/feed.xml">';

  it("on the home page, the archive index, and a post page", async () => {
    const { post } = await sendPost("Linked", "body");
    for (const path of ["/", "/archive", `/archive/${post.slug}`]) {
      expect(await (await SELF.fetch(`${base}${path}`)).text()).toContain(link);
    }
  });

  it("not on an email-only post's page, which names no archive address", async () => {
    const { post } = await sendPost("Inbox only", "body");
    await env.DB.prepare("UPDATE posts SET email_only = 1 WHERE id = ?").bind(post.id).run();
    const page = await (await SELF.fetch(`${base}/email/${post.unlisted_token}`)).text();
    expect(page).toContain("Inbox only");
    expect(page).not.toContain("application/rss+xml");
  });

  it("never in the frozen email (I3)", async () => {
    const { sendId } = await sendPost("Not in the email", "body");
    expect((await getSend(env.DB, sendId))!.rendered_html).not.toContain("application/rss+xml");
  });
});

describe("plainTextAsHtml", () => {
  it("makes each block a paragraph and keeps its line breaks, escaped", () => {
    expect(plainTextAsHtml("one\ntwo\n\n\n- a <b>\n\n")).toBe(
      "<p>one<br>two</p>\n<p>- a &lt;b&gt;</p>",
    );
  });
});
