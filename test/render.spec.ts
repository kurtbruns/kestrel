import { describe, expect, it } from "vitest";
import type { ImageRow } from "../src/db/images";
import type { PostRow, RevisionRow } from "../src/db/posts";
import type { Config } from "../src/env";
import { render, SENTTO_SENTINEL, substituteRecipient, UNSUB_SENTINEL } from "../src/render/render";

const config: Config = {
  provider: "fake",
  appOrigin: "https://app.example",
  archiveOrigin: "https://arc.example",
  archiveBasePath: "/archive",
  mediaPublicBase: "https://media.example",
  sendingDomain: "send.example",
  fromAddress: "News <news@send.example>",
  awsRegion: "us-east-1",
  devMode: false,
  simulateSends: false,
  subrequestBudget: 50,
};

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: "p1",
    slug: "weekly-news",
    subject: "This week in cats",
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
      subject: "This week in cats",
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

describe("render (the single render path)", async () => {
  it("resolves images to absolute URLs, caps size, keeps the sentinel, sets subject", async () => {
    const result = await render(
      {
        post: post(),
        revision: revision("# Hello\n\n![A cat](cat.png)\n\n[link](https://x.com)"),
        images: [image()],
      },
      config,
    );
    expect(result.subject).toBe("This week in cats");
    expect(result.html).toContain("https://media.example/posts/p1/cat.png");
    expect(result.html).toContain('width="600" height="300"'); // 1200x600 capped to 600 wide
    expect(result.html).toContain(UNSUB_SENTINEL);
    expect(result.warnings).toEqual([]);
  });

  it("flags missing alt text", async () => {
    const result = await render(
      { post: post(), revision: revision("![](cat.png)"), images: [image()] },
      config,
    );
    expect(result.warnings.join(" ")).toMatch(/missing alt/i);
  });

  it("warns on an empty or whitespace-only subject and falls back to (no subject)", async () => {
    for (const subject of ["", "   "]) {
      const result = await render(
        { post: post({ subject }), revision: revision("body", { subject }), images: [] },
        config,
      );
      expect(result.subject).toBe("(no subject)");
      expect(result.warnings.join(" ")).toMatch(/no subject/i);
    }
  });

  it("flags an unresolved image reference", async () => {
    const result = await render(
      { post: post(), revision: revision("![x](ghost.png)"), images: [] },
      config,
    );
    expect(result.warnings.join(" ")).toMatch(/not found/i);
  });

  it("is deterministic (same input → same bytes)", async () => {
    const input = { post: post(), revision: revision("# Same\n\ntext"), images: [] };
    expect((await render(input, config)).html).toBe((await render(input, config)).html);
  });

  it("runs the hygiene pass over author HTML", async () => {
    const result = await render(
      {
        post: post(),
        revision: revision('Hi\n\n<script>alert(1)</script>\n\n<a href="javascript:evil()">x</a>'),
        images: [],
      },
      config,
    );
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("javascript:");
  });

  it("produces a text part with links and the unsubscribe sentinel", async () => {
    const result = await render(
      { post: post(), revision: revision("Read [here](https://x.com) now"), images: [] },
      config,
    );
    expect(result.text).toContain("here (https://x.com)");
    expect(result.text).toContain(`Unsubscribe: ${UNSUB_SENTINEL}`);
    expect(result.text).toContain("View in browser: https://arc.example/archive/weekly-news");
  });

  it("substituteRecipient replaces the per-recipient sentinels", async () => {
    const result = await render({ post: post(), revision: revision("hi"), images: [] }, config);
    const sub = substituteRecipient(result, {
      "email.unsubscribeUrl": "https://app.example/u/abc",
      "email.sentTo": "reader@example.com",
    });
    expect(sub.subject).toBe(result.subject);
    expect(sub.html).not.toContain(UNSUB_SENTINEL);
    expect(sub.html).toContain("https://app.example/u/abc");
    expect(sub.text).not.toContain(UNSUB_SENTINEL);
  });

  it("fills {{ email.sentTo }} with the recipient's address at delivery", async () => {
    const branding = {
      template:
        '<div class="email">{{ post.body }}<footer>Sent to {{ email.sentTo }} · ' +
        '<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></footer></div>',
      name: "N",
      tagline: "t",
      logoUrl: "",
      address: "",
    };
    const result = await render(
      { post: post(), revision: revision("hi"), images: [] },
      config,
      branding,
    );
    // Frozen with the sentinel, not any recipient address (I3).
    expect(result.html).toContain(SENTTO_SENTINEL);
    const sub = substituteRecipient(result, {
      "email.unsubscribeUrl": "https://app.example/u/abc",
      "email.sentTo": "reader@example.com",
    });
    expect(sub.html).not.toContain(SENTTO_SENTINEL);
    expect(sub.html).toContain("reader@example.com");
  });

  it("delivery substitution is byte-identical to a raw sentinel replacement (flavor 2, I5)", async () => {
    // The unified delivery pass must emit the exact bytes the pre-unification split/join
    // did, for a fixed (post, template, recipient) — the unification changes no wire byte.
    const branding = {
      template:
        '<div class="email">{{ post.body }}<footer>Sent to {{ email.sentTo }} · ' +
        '<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></footer></div>',
      name: "N",
      tagline: "t",
      logoUrl: "",
      address: "",
    };
    const result = await render(
      { post: post(), revision: revision("# Hi\n\nbody"), images: [] },
      config,
      branding,
    );
    // A multi-param URL (with `&`) proves the unsubscribe URL is inserted RAW, not
    // attribute-escaped — the property flavor 2 preserves. `sentTo` here has no special
    // characters, so its attribute-safe form equals its raw form and a plain join matches.
    const url = "https://app.example/unsubscribe?token=abc&uid=42";
    const sentTo = "reader@example.com";
    const sub = substituteRecipient(result, {
      "email.unsubscribeUrl": url,
      "email.sentTo": sentTo,
    });
    expect(sub.html).toBe(
      result.html.split(UNSUB_SENTINEL).join(url).split(SENTTO_SENTINEL).join(sentTo),
    );
    expect(sub.text).toBe(
      result.text.split(UNSUB_SENTINEL).join(url).split(SENTTO_SENTINEL).join(sentTo),
    );
    expect(sub.html).toContain(`href="${url}"`); // the `&` survives unescaped
  });

  it("fills the template with the publication identity + a custom template's markup", async () => {
    const branding = {
      template:
        '<div class="email">{{ post.body }}<footer>{{ publication.name }} · ' +
        '<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a> · ' +
        '<a href="{{ email.viewInBrowserUrl }}">View in browser</a></footer></div>',
      name: "Windbreak",
      tagline: "Field notes",
      logoUrl: "https://media.example/branding/logo?v=1",
      address: "123 Marsh Lane",
    };
    const result = await render(
      { post: post(), revision: revision("# Hi\n\nbody"), images: [] },
      config,
      branding,
    );
    expect(result.html).toContain("Windbreak");
    expect(result.html).toContain(UNSUB_SENTINEL);
    // The view-in-browser variable is filled with the archive URL.
    expect(result.html).toContain("https://arc.example/archive/weekly-news");
    expect(result.warnings).toEqual([]);
  });

  it("ships light+dark support: advertises the color-scheme and keeps a dark @media block", async () => {
    const result = await render(
      { post: post(), revision: revision("# Hi\n\nbody"), images: [] },
      config,
    );
    // color-scheme opts the email into client dark handling…
    expect(result.html).toContain('content="light dark"');
    // …and the dark rules survive inlining as an @media block (they can't be inlined).
    expect(result.html).toContain("prefers-color-scheme: dark");
    expect(result.html).toContain("#ededed"); // light body text in dark mode
  });

  it("falls back to the default template (with a warning) when the active one is invalid", async () => {
    const branding = {
      template: "<div>{{ post.body }}</div>", // no unsubscribe → invalid
      name: "",
      tagline: "",
      logoUrl: "",
      address: "",
    };
    const result = await render(
      { post: post(), revision: revision("hi"), images: [] },
      config,
      branding,
    );
    // Defense in depth: an unsubscribe-less template can never ship (I2).
    expect(result.html).toContain(UNSUB_SENTINEL);
    expect(result.warnings.join(" ")).toMatch(/template invalid/i);
  });
});
