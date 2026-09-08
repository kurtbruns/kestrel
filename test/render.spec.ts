import { describe, expect, it } from "vitest";
import type { Config } from "../src/env";
import type { PostRow, RevisionRow } from "../src/db/posts";
import type { ImageRow } from "../src/db/images";
import { render, substituteUnsubscribe, UNSUB_SENTINEL } from "../src/render/render";

const config: Config = {
  provider: "fake",
  appOrigin: "https://app.example",
  archiveOrigin: "https://arc.example",
  archiveBasePath: "/newsletter",
  mediaPublicBase: "https://media.example",
  sendingDomain: "news.example",
  fromAddress: "News <news@news.example>",
  awsRegion: "us-east-1",
};

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: "p1",
    slug: "weekly-news",
    title: "Weekly News",
    subject: "This week in cats",
    preheader: "Your Monday digest",
    status: "draft",
    current_revision: "r1",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function revision(markdown: string, metaOver: Record<string, string> = {}): RevisionRow {
  return {
    id: "r1",
    post_id: "p1",
    markdown,
    metadata: JSON.stringify({
      title: "Weekly News",
      subject: "This week in cats",
      preheader: "Your Monday digest",
      slug: "weekly-news",
      ...metaOver,
    }),
    author: "service",
    created_at: 0,
  };
}

function image(over: Partial<ImageRow> = {}): ImageRow {
  return {
    id: "i1",
    post_id: "p1",
    filename: "cat.png",
    storage_key: "posts/p1/cat.png",
    content_type: "image/png",
    width: 1200,
    height: 600,
    created_at: 0,
    ...over,
  };
}

describe("render (the single render path)", () => {
  it("resolves images to absolute URLs, caps size, keeps the sentinel, sets subject", () => {
    const result = render(
      { post: post(), revision: revision("# Hello\n\n![A cat](cat.png)\n\n[link](https://x.com)"), images: [image()] },
      config,
    );
    expect(result.subject).toBe("This week in cats");
    expect(result.html).toContain("https://media.example/posts/p1/cat.png");
    expect(result.html).toContain('width="600" height="300"'); // 1200x600 capped to 600 wide
    expect(result.html).toContain(UNSUB_SENTINEL);
    expect(result.warnings).toEqual([]);
  });

  it("flags missing alt text", () => {
    const result = render({ post: post(), revision: revision("![](cat.png)"), images: [image()] }, config);
    expect(result.warnings.join(" ")).toMatch(/missing alt/i);
  });

  it("flags an unresolved image reference", () => {
    const result = render({ post: post(), revision: revision("![x](ghost.png)"), images: [] }, config);
    expect(result.warnings.join(" ")).toMatch(/not found/i);
  });

  it("is deterministic (same input → same bytes)", () => {
    const input = { post: post(), revision: revision("# Same\n\ntext"), images: [] };
    expect(render(input, config).html).toBe(render(input, config).html);
  });

  it("runs the hygiene pass over author HTML", () => {
    const result = render(
      { post: post(), revision: revision("Hi\n\n<script>alert(1)</script>\n\n<a href=\"javascript:evil()\">x</a>"), images: [] },
      config,
    );
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("javascript:");
  });

  it("produces a text part with links and the unsubscribe sentinel", () => {
    const result = render({ post: post(), revision: revision("Read [here](https://x.com) now"), images: [] }, config);
    expect(result.text).toContain("here (https://x.com)");
    expect(result.text).toContain(`Unsubscribe: ${UNSUB_SENTINEL}`);
    expect(result.text).toContain("View in browser: https://arc.example/newsletter/weekly-news");
  });

  it("substituteUnsubscribe replaces only the sentinel", () => {
    const result = render({ post: post(), revision: revision("hi"), images: [] }, config);
    const sub = substituteUnsubscribe(result, "https://app.example/u/abc");
    expect(sub.subject).toBe(result.subject);
    expect(sub.html).not.toContain(UNSUB_SENTINEL);
    expect(sub.html).toContain("https://app.example/u/abc");
    expect(sub.text).not.toContain(UNSUB_SENTINEL);
  });
});
