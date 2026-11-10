// What a reader page says about itself (SPEC §5): the description and link-preview tags in its
// head, each from words the publisher already wrote, left out when its source is empty, and
// never naming a token or an unlisted link. A post page's tags are served at the head anchor,
// so the frozen copy and every email stay as they were (I3).

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { getSend } from "../src/db/sends";
import { newLogoKey, setPublicationLogo, updateSettings } from "../src/db/settings";
import { getConfig } from "../src/env";
import { describeHead, postDescription, shorten } from "../src/lib/describe";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import { dueSend, resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { fetchWith } from "./support/worker_env";

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  clearFakeOutbox();
  await seedConfirmed("a@example.com");
});

/** The page's description and preview tags, by name, in the order they appear. */
function tagsOf(page: string): Record<string, string> {
  const head = page.slice(0, page.indexOf("</head>"));
  const tags: Record<string, string> = {};
  for (const m of head.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]*)">/g)) {
    const [, key, value] = m as unknown as [string, string, string];
    if (key === "description" || key.startsWith("og:") || key.startsWith("twitter:")) {
      tags[key] = value
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    }
  }
  return tags;
}

const page = async (path: string) => (await SELF.fetch(`${base}${path}`)).text();

/** The app's own origin, which every public address the app names is built on. */
const origin = () => getConfig(env).appOrigin;

async function withIdentity(): Promise<string> {
  await updateSettings(env.DB, {
    publication: { name: "Field Notes", tagline: "Chicken scratch, delivered weekly." },
  });
  const key = newLogoKey(1);
  await setPublicationLogo(env.DB, { version: 1, contentType: "image/png", key });
  return `${getConfig(env).mediaPublicBase}/${key}`;
}

/** A post sent to one reader through the sweep, its listing as given. */
async function sendPost(
  subject: string,
  markdown: string,
  emailOnly = false,
): Promise<{ post: posts.PostRow; sendId: string }> {
  const send = await dueSend({ subject, markdown });
  if (emailOnly) {
    await env.DB.prepare("UPDATE posts SET email_only = 1 WHERE id = ?").bind(send.post_id).run();
  }
  await sweep(env);
  return { post: (await posts.getPost(env.DB, send.post_id))!, sendId: send.id };
}

describe("the home page, archive index, and subscribe page describe the publication (SPEC §5)", () => {
  it("takes each tag from the name, tagline, logo, and the page's own address", async () => {
    const logo = await withIdentity();
    const site = {
      description: "Chicken scratch, delivered weekly.",
      "og:type": "website",
      "og:title": "Field Notes",
      "og:description": "Chicken scratch, delivered weekly.",
      "og:image": logo,
      "twitter:card": "summary",
    };
    expect(tagsOf(await page("/"))).toEqual({ ...site, "og:url": `${origin()}/` });
    expect(tagsOf(await page("/archive"))).toEqual({ ...site, "og:url": `${origin()}/archive` });
    expect(tagsOf(await page("/subscribe"))).toEqual({
      ...site,
      "og:url": `${origin()}/subscribe`,
    });
  });

  it("leaves a tag out when its source is empty, never emitting it empty", async () => {
    for (const path of ["/", "/archive", "/subscribe"]) {
      const html = await page(path);
      expect(tagsOf(html), path).toEqual({ "og:type": "website", "og:url": `${origin()}${path}` });
      expect(html, path).not.toContain('content=""');
    }
  });

  it("names the logo at the public media address, on a separate bucket domain too", async () => {
    const key = newLogoKey(3);
    await setPublicationLogo(env.DB, { version: 3, contentType: "image/png", key });
    const html = await (
      await fetchWith({ MEDIA_PUBLIC_BASE: "https://media.birds.example" }, "/")
    ).text();
    expect(tagsOf(html)["og:image"]).toBe(`https://media.birds.example/${key}`);
  });

  it("names the archive at its configured origin and base path", async () => {
    const html = await (
      await fetchWith(
        { ARCHIVE_ORIGIN: "https://birds.example", ARCHIVE_BASE_PATH: "/notes" },
        "/notes",
      )
    ).text();
    expect(tagsOf(html)["og:url"]).toBe("https://birds.example/notes");
  });

  it("escapes every value as an attribute", async () => {
    await updateSettings(env.DB, {
      publication: { name: `Birds & "Bees" <weekly>`, tagline: `It's <b>loud</b> & "clear"` },
    });
    const html = await page("/");
    expect(html).toContain(
      `<meta name="description" content="It&#39;s &lt;b&gt;loud&lt;/b&gt; &amp; &quot;clear&quot;">`,
    );
    expect(html).toContain(
      `<meta property="og:title" content="Birds &amp; &quot;Bees&quot; &lt;weekly&gt;">`,
    );
    expect(html).not.toContain("<b>loud");
  });
});

describe("a page reached from an email says nothing about itself (SPEC §5)", () => {
  it("carries no description or preview tag, so none repeats a token in its address", async () => {
    for (const path of [
      "/confirm?token=cfm-a@example.com",
      "/confirm?token=nope",
      "/unsubscribe?token=uns-a@example.com",
      "/unsubscribe?token=nope",
      "/archive/missing",
      "/no/such/page",
    ]) {
      await withIdentity();
      const res = await SELF.fetch(`${base}${path}`, { headers: { accept: "text/html" } });
      const html = await res.text();
      expect(html, path).toContain("<title>");
      expect(tagsOf(html), path).toEqual({});
    }
  });
});

describe("a post page describes the post (SPEC §5)", () => {
  it("takes its title from the subject and its description from the opening text readers received", async () => {
    const logo = await withIdentity();
    const { post } = await sendPost(
      "First Frost",
      "# First Frost\n\nThe [garden](https://example.com/garden) went white overnight.\n\nMore below.",
    );
    expect(tagsOf(await page(`/archive/${post.slug}`))).toEqual({
      description: "The garden went white overnight. More below.",
      "og:type": "article",
      "og:title": "First Frost",
      "og:description": "The garden went white overnight. More below.",
      "og:url": `${origin()}/archive/${post.slug}`,
      "og:image": logo,
      "twitter:card": "summary",
    });
  });

  it("falls back to the tagline when the post opens with no prose, and leaves the description out with neither", async () => {
    const { post } = await sendPost("Just a picture", "![a heron](https://example.com/heron.png)");
    expect(tagsOf(await page(`/archive/${post.slug}`))).toEqual({
      "og:type": "article",
      "og:title": "Just a picture",
      "og:url": `${origin()}/archive/${post.slug}`,
      "twitter:card": "summary",
    });
    await updateSettings(env.DB, { publication: { tagline: "Birds, mostly." } });
    expect(tagsOf(await page(`/archive/${post.slug}`)).description).toBe("Birds, mostly.");
  });

  it("serves an email-only post's tags with no address, and none names its unlisted link", async () => {
    const logo = await withIdentity();
    const { post } = await sendPost("Correction", "Last week's date was wrong.", true);
    const html = await page(`/email/${post.unlisted_token}`);
    expect(tagsOf(html)).toEqual({
      description: "Last week's date was wrong.",
      "og:type": "article",
      "og:title": "Correction",
      "og:description": "Last week's date was wrong.",
      "og:image": logo,
      "twitter:card": "summary",
    });
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).not.toContain(post.unlisted_token);
    expect(head).not.toContain("/archive/");
  });

  it("adds the tags only to the served page, never to the frozen copy or the email (I3)", async () => {
    await withIdentity();
    const { post, sendId } = await sendPost("Kept", "# Kept\n\nThe words as sent.");
    const before = (await getSend(env.DB, sendId))!;
    const served = await page(`/archive/${post.slug}`);
    const after = (await getSend(env.DB, sendId))!;
    expect(tagsOf(served)["og:title"]).toBe("Kept");
    // The frozen row is byte for byte the same after the page is served.
    expect(after.rendered_html).toBe(before.rendered_html);
    expect(after.rendered_text).toBe(before.rendered_text);
    // Neither the record nor the email a reader got carries any of the tags.
    for (const html of [before.rendered_html, fakeOutbox()[0]!.html]) {
      expect(html).not.toContain('name="description"');
      expect(html).not.toContain('property="og:');
      expect(html).not.toContain('name="twitter:');
    }
  });
});

describe("the publisher's previews of reader pages carry the real page's head (SPEC §5)", () => {
  it("previews the post page and the home page with their tags", async () => {
    await withIdentity();
    const preview = async (p: string) =>
      (await SELF.fetch(`${base}/api/reader-pages/${p}`, { headers: AUTH })).text();
    const post = tagsOf(await preview("reading/post"));
    expect(post["og:type"]).toBe("article");
    expect(post["og:url"]).toBe(`${origin()}/archive/sample-post`);
    expect(post.description).toBe(
      "This is a test of your email template, with sample text. A real post’s Markdown fills this space. It shows the parts of a post that a template styles…",
    );
    expect(tagsOf(await preview("reading/landing"))).toEqual(tagsOf(await page("/")));
  });
});

describe("a post's description (SPEC §5)", () => {
  const FOOTER = "\n\n—\nPowered by Kestrel\nView in browser: https://app.example/email/s3cret\n";

  it("keeps only prose: no repeated subject, image, link address, list dash, or footer", () => {
    const text =
      "Spring Notes\n\n[a heron]\n\nWhat we saw\n\nRead the [paper] (https://x.example/a_(b)).\n\n- one\n- two" +
      FOOTER;
    expect(postDescription(text, "spring notes")).toBe("What we saw — Read the [paper]. one — two");
  });

  it("keeps a quote's words as the opening and collapses whitespace", () => {
    expect(postDescription(`“Look   up,” she said.\n\nAnd we did.${FOOTER}`, "Up")).toBe(
      "“Look up,” she said. And we did.",
    );
  });

  it("is empty when nothing but the footer is left", () => {
    expect(postDescription(`[only an image]${FOOTER}`, "Pic")).toBe("");
  });

  it("is kept whole at the limit and cut at a word with an ellipsis past it", () => {
    const exact = `${"word ".repeat(31)}abcd`; // 159 characters
    expect(Array.from(`${exact}!`).length).toBe(160);
    expect(shorten(`${exact}!`, 160)).toBe(`${exact}!`);
    const cut = shorten(`${"word, ".repeat(40)}end`, 160);
    expect(cut).toBe(`${"word, ".repeat(25)}word…`);
    expect(Array.from(cut).length).toBeLessThanOrEqual(160);
  });

  it("cuts a single overlong word, and never splits a character", () => {
    expect(shorten("x".repeat(200), 160)).toBe(`${"x".repeat(159)}…`);
    expect(shorten("🐦".repeat(200), 160)).toBe(`${"🐦".repeat(159)}…`);
  });

  it("emits no card when there is neither a title nor a description", () => {
    expect(
      describeHead({ type: "website", title: "", description: "", url: "https://a.example/" }),
    ).toBe(
      '<meta property="og:type" content="website"><meta property="og:url" content="https://a.example/">',
    );
  });
});
