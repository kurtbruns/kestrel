import { describe, expect, it } from "vitest";
import type { ImageRow } from "../src/db/images";
import type { PostRow, RevisionRow } from "../src/db/posts";
import { DEFAULT_SETTINGS } from "../src/db/settings";
import type { Config } from "../src/env";
import {
  omitEmailOnly,
  render,
  SENTTO_SENTINEL,
  substituteRecipient,
  UNSUB_SENTINEL,
} from "../src/render/render";
import { emailOnlyRegionsWhole } from "../src/render/template";
import {
  DEFAULT_EMAIL_TEMPLATE,
  defaultBranding,
  resolveBranding,
} from "../src/render/template_engine";

const config: Config = {
  provider: "fake",
  appOrigin: "https://app.example",
  archiveOrigin: "https://arc.example",
  archiveBasePath: "/archive",
  mediaPublicBase: "https://media.example",
  sendingDomain: "send.example",
  fromAddress: "News <news@send.example>",
  awsRegion: "us-east-1",
  sesMaxSendRate: 14,
  sesMaxSendRateSetting: null,
  devMode: false,
  devShaped: false,
  simulation: null,
  notConnectedPreview: false,
  subrequestBudget: 50,
  minLeadMs: 5 * 60 * 1000,
};

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: "p1",
    slug: "weekly-news",
    slug_auto: false,
    unlisted_token: "01234567-89abcdef-01234567-89abcdef",
    subject: "This week in cats",
    status: "draft",
    email_only: false,
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
    client: null,
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

/** The warning for an image uploaded to the post that it doesn't use. */
function unused(name: string): string {
  return `The uploaded image “${name}” isn’t used in this post.`;
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
    expect(result.warnings).toEqual([
      "The image “cat.png” has no alt text. Describe it between the square brackets.",
    ]);
  });

  it("warns on an empty or whitespace-only subject and falls back to (no subject)", async () => {
    for (const subject of ["", "   "]) {
      const result = await render(
        { post: post({ subject }), revision: revision("body", { subject }), images: [] },
        config,
      );
      expect(result.subject).toBe("(no subject)");
      expect(result.warnings).toEqual([
        "There’s no subject, so the email will show “(no subject)”. Add one before you schedule.",
      ]);
    }
  });

  it("flags an unresolved image reference", async () => {
    const result = await render(
      { post: post(), revision: revision("![x](ghost.png)"), images: [] },
      config,
    );
    expect(result.warnings).toEqual([
      "The image “ghost.png” isn’t on this post. Upload it, or check the file name.",
    ]);
  });

  it("checks an image referenced by its full address on this instance like a name, and says to use the name (SPEC §4)", async () => {
    const result = await render(
      {
        post: post(),
        revision: revision("![A cat](https://media.example/posts/p1/cat.png)"),
        images: [image()],
      },
      config,
    );
    expect(result.html).toContain('src="https://media.example/posts/p1/cat.png"');
    expect(result.html).toContain('width="600" height="300"');
    expect(result.warnings).toEqual([
      "The image “https://media.example/posts/p1/cat.png” should be referenced as “cat.png”. Use its file name, not its address.",
    ]);
  });

  it("flags an image addressed on this instance that isn't this post's: deleted, or another post's (SPEC §4)", async () => {
    for (const href of [
      "https://media.example/posts/p1/gone.png",
      "https://media.example/posts/p2/cat.png",
    ]) {
      const result = await render(
        { post: post(), revision: revision(`![A cat](${href})`), images: [image()] },
        config,
      );
      expect(result.html).toContain(`src="${href}"`);
      expect(result.warnings).toEqual([
        `The image “${href}” isn’t on this post. Upload it to this post and reference it by its file name.`,
        unused("cat.png"),
      ]);
    }
  });

  describe("a reference that didn't become an image (SPEC §4)", () => {
    const warningFor = (written: string) =>
      `“${written}” won’t show as an image, so readers will see it as typed. Check it for a space or a stray bracket, and reference an uploaded image by its file name.`;
    const warningsOf = async (markdown: string) =>
      (await render({ post: post(), revision: revision(markdown), images: [] }, config)).warnings;

    it("warns on one the parser left as text, wherever it sits", async () => {
      const broken = "![A cat](my cat.png)";
      for (const markdown of [
        broken,
        `Before ${broken} after`,
        `# ${broken}`,
        `> ${broken}`,
        `- ${broken}`,
        `**${broken}**`,
        `| a |\n| - |\n| ${broken} |`,
      ]) {
        expect(await warningsOf(markdown), markdown).toEqual([warningFor(broken)]);
      }
    });

    it("warns on the name a macOS screenshot gets, narrow no-break space included", async () => {
      const broken = "![Shot 9.41 AM.png](Shot 9.41 AM.png)";
      expect(await warningsOf(broken)).toEqual([warningFor(broken)]);
    });

    it("warns on each one, and on one with no closing parenthesis", async () => {
      expect(await warningsOf("![a](b c)\n\n![d](e f)")).toEqual([
        warningFor("![a](b c)"),
        warningFor("![d](e f)"),
      ]);
      expect(await warningsOf("![a](b c")).toEqual([warningFor("![a](b c")]);
    });

    it("says nothing of a reference shown as code or escaped on purpose", async () => {
      for (const markdown of [
        "Write `![A cat](my cat.png)` to add an image.",
        "```\n![A cat](my cat.png)\n```",
        "\\![A cat](my cat.png)",
      ]) {
        expect(await warningsOf(markdown), markdown).toEqual([]);
      }
    });

    it("says nothing of text with the same punctuation that reads as no reference", async () => {
      expect(await warningsOf("Wow! [This](https://x.com) and hey![that] (there)")).toEqual([]);
    });

    it("doesn't change the email", async () => {
      const input = { post: post(), revision: revision("![a](b c)"), images: [] };
      const result = await render(input, config);
      expect(result.warnings).toHaveLength(1);
      expect(result.html).toContain("![a](b c)");
      expect(result.html).not.toContain("<img");
    });
  });

  describe("an image uploaded to the post that it doesn't use (SPEC §4)", () => {
    it("warns on each one the post doesn't reference", async () => {
      const result = await render(
        {
          post: post(),
          revision: revision("![A cat](cat.png)"),
          images: [
            image({ id: "i0", filename: "a.png", storage_key: "posts/p1/a.png" }),
            image(),
            image({ id: "i2", filename: "z.png", storage_key: "posts/p1/z.png" }),
          ],
        },
        config,
      );
      expect(result.warnings).toEqual([unused("a.png"), unused("z.png")]);
    });

    it("counts a reference by a path or the image's full address as using it", async () => {
      for (const markdown of [
        "![A cat](images/cat.png)",
        "![A cat](https://media.example/posts/p1/cat.png)",
      ]) {
        const result = await render(
          { post: post(), revision: revision(markdown), images: [image()] },
          config,
        );
        expect(result.warnings, markdown).not.toContain(unused("cat.png"));
      }
    });

    it("says nothing of an image the email reaches by its full address some other way", async () => {
      const address = "https://media.example/posts/p1/cat.png";
      for (const markdown of [
        `<img src="${address}" alt="A cat">`,
        `[See the cat](${address})`,
        `<div style="background-image:url(${address})">A cat</div>`,
      ]) {
        const result = await render(
          { post: post(), revision: revision(markdown), images: [image()] },
          config,
        );
        expect(result.html, markdown).toContain(address);
        expect(result.warnings, markdown).toEqual([]);
      }
    });

    it("says nothing of an image whose address reaches the email escaped or encoded", async () => {
      const spaced = image({ filename: "my cat.png", storage_key: "posts/p1/my cat.png" });
      const amp = image({ filename: "cat&dog.png", storage_key: "posts/p1/cat&dog.png" });
      const accent = image({ filename: "café&co.png", storage_key: "posts/p1/café&co.png" });
      for (const [markdown, img] of [
        ['<img src="https://media.example/posts/p1/my%20cat.png" alt="A cat">', spaced],
        ["[See the pair](https://media.example/posts/p1/cat&dog.png)", amp],
        ["[See the caf\u00e9](https://media.example/posts/p1/caf\u00e9&co.png)", accent],
      ] as const) {
        const result = await render(
          { post: post(), revision: revision(markdown), images: [img] },
          config,
        );
        expect(result.warnings, markdown).toEqual([]);
      }
    });

    it("warns on a raw reference by bare name, which the render leaves unresolved", async () => {
      const result = await render(
        { post: post(), revision: revision('<img src="cat.png" alt="A cat">'), images: [image()] },
        config,
      );
      expect(result.html).not.toContain("https://media.example/posts/p1/cat.png");
      expect(result.warnings).toEqual([unused("cat.png")]);
    });

    it("counts a name only in a code span as not using it, and an old name in angle brackets as using it", async () => {
      const inCode = await render(
        { post: post(), revision: revision("`![A cat](cat.png)`"), images: [image()] },
        config,
      );
      expect(inCode.warnings).toEqual([unused("cat.png")]);
      const spaced = image({ filename: "my cat.png", storage_key: "posts/p1/my cat.png" });
      const bracketed = await render(
        { post: post(), revision: revision("![A cat](<my cat.png>)"), images: [spaced] },
        config,
      );
      expect(bracketed.warnings).toEqual([]);
    });

    it("doesn't change the email", async () => {
      const input = { post: post(), revision: revision("Just words"), images: [] };
      const without = await render(input, config);
      const withUnused = await render({ ...input, images: [image()] }, config);
      expect(withUnused.warnings).toEqual([unused("cat.png")]);
      expect(withUnused.html).toBe(without.html);
      expect(withUnused.text).toBe(without.text);
    });
  });

  it("passes an image on another host through untouched, with no warning of its own", async () => {
    const href = "https://elsewhere.example/posts/p1/cat.png";
    const result = await render(
      { post: post(), revision: revision(`![A cat](${href})`), images: [image()] },
      config,
    );
    expect(result.html).toContain(`src="${href}"`);
    expect(result.html).toContain(`src="${href}" alt="A cat" style=`); // no size: not ours
    expect(result.warnings).toEqual([unused("cat.png")]); // the upload it only looks like
  });

  it("prints the mailing address in the built-in template's footer only when one is set (SPEC §9)", async () => {
    const input = { post: post(), revision: revision("body"), images: [] };
    const addressLine = (html: string) =>
      /<div class="address"[^>]*>([^<]*)<\/div>/.exec(html)?.[1];
    const blank = await render(input, config);
    expect(addressLine(blank.html)).toBe("");
    const set = await render(input, config, {
      ...defaultBranding(),
      address: "PO Box 1142, Portland, OR 97207",
    });
    expect(addressLine(set.html)).toBe("PO Box 1142, Portland, OR 97207");
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

  it("links every email's web version through the post's unlisted link on the app's origin, never its archive address (SPEC §5)", async () => {
    const result = await render(
      { post: post({ slug: "weekly-news" }), revision: revision("body"), images: [] },
      config,
    );
    const link = "https://app.example/email/01234567-89abcdef-01234567-89abcdef";
    expect(result.text).toContain(`View in browser: ${link}`);
    expect(result.html).not.toContain("weekly-news");
  });

  it("produces a text part with links and the unsubscribe sentinel", async () => {
    const result = await render(
      { post: post(), revision: revision("Read [here](https://x.com) now"), images: [] },
      config,
    );
    expect(result.text).toContain("here (https://x.com)");
    expect(result.text).toContain(`Unsubscribe: ${UNSUB_SENTINEL}`);
    expect(result.text).toContain(
      "View in browser: https://app.example/email/01234567-89abcdef-01234567-89abcdef",
    );
  });

  it("ends the text part's footer with the mailing address only when one is set (SPEC §9)", async () => {
    const input = { post: post(), revision: revision("body"), images: [] };
    const footer = [
      "body",
      "",
      "—",
      "Powered by Kestrel",
      "View in browser: https://app.example/email/01234567-89abcdef-01234567-89abcdef",
      `Unsubscribe: ${UNSUB_SENTINEL}`,
    ];
    const blank = await render(input, config);
    expect(blank.text).toBe([...footer, ""].join("\n"));
    const set = await render(input, config, {
      ...defaultBranding(),
      address: "PO Box 1142, Portland, OR 97207",
    });
    expect(set.text).toBe([...footer, "PO Box 1142, Portland, OR 97207", ""].join("\n"));
  });

  it("leaves the address out of the text part while the template leaves out its placeholder, so the parts agree (SPEC §9)", async () => {
    const input = { post: post(), revision: revision("body"), images: [] };
    const address = "PO Box 1142, Portland, OR 97207";
    const without = await render(input, config, {
      ...defaultBranding(),
      template: '{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a>',
      address,
    });
    expect(without.html).not.toContain(address);
    expect(without.text).not.toContain(address);
    expect(without.text.endsWith(`Unsubscribe: ${UNSUB_SENTINEL}\n`)).toBe(true);
    const withIt = await render(input, config, {
      ...defaultBranding(),
      template:
        '{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a><p>{{ .Publication.Address }}</p>',
      address,
    });
    expect(withIt.html).toContain(address);
    expect(withIt.text.endsWith(`Unsubscribe: ${UNSUB_SENTINEL}\n${address}\n`)).toBe(true);
  });

  it("substituteRecipient replaces the per-recipient sentinels", async () => {
    const result = await render({ post: post(), revision: revision("hi"), images: [] }, config);
    const sub = substituteRecipient(result, {
      ".Email.UnsubscribeURL": "https://app.example/u/abc",
      ".Email.SentTo": "reader@example.com",
    });
    expect(sub.subject).toBe(result.subject);
    expect(sub.html).not.toContain(UNSUB_SENTINEL);
    expect(sub.html).toContain("https://app.example/u/abc");
    expect(sub.text).not.toContain(UNSUB_SENTINEL);
  });

  it("fills {{ .Email.SentTo }} with the recipient's address at delivery", async () => {
    const branding = {
      template:
        '<div class="email">{{ .Post.Body }}<footer>Sent to {{ .Email.SentTo }} · ' +
        '<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></footer></div>',
      name: "N",
      tagline: "t",
      logoUrl: "",
      address: "",
      senderName: "",
    };
    const result = await render(
      { post: post(), revision: revision("hi"), images: [] },
      config,
      branding,
    );
    // Frozen with the sentinel, not any recipient address (I3).
    expect(result.html).toContain(SENTTO_SENTINEL);
    const sub = substituteRecipient(result, {
      ".Email.UnsubscribeURL": "https://app.example/u/abc",
      ".Email.SentTo": "reader@example.com",
    });
    expect(sub.html).not.toContain(SENTTO_SENTINEL);
    expect(sub.html).toContain("reader@example.com");
  });

  it("delivery substitution is byte-identical to a raw sentinel replacement (flavor 2, I5)", async () => {
    // The unified delivery pass must emit the exact bytes the pre-unification split/join
    // did, for a fixed (post, template, recipient) — the unification changes no wire byte.
    const branding = {
      template:
        '<div class="email">{{ .Post.Body }}<footer>Sent to {{ .Email.SentTo }} · ' +
        '<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></footer></div>',
      name: "N",
      tagline: "t",
      logoUrl: "",
      address: "",
      senderName: "",
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
      ".Email.UnsubscribeURL": url,
      ".Email.SentTo": sentTo,
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
        '<div class="email">{{ .Post.Body }}<footer>{{ .Publication.Name }} · ' +
        '<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a> · ' +
        '<a href="{{ .Email.ViewInBrowserURL }}">View in browser</a></footer></div>',
      name: "Field Notes",
      tagline: "Notes on keeping a small newsletter",
      logoUrl: "https://media.example/branding/logo?v=1",
      address: "123 Marsh Lane",
      senderName: "",
    };
    const result = await render(
      { post: post(), revision: revision("# Hi\n\nbody"), images: [] },
      config,
      branding,
    );
    expect(result.html).toContain("Field Notes");
    expect(result.html).toContain(UNSUB_SENTINEL);
    // The view-in-browser variable is filled with the archive URL.
    expect(result.html).toContain("https://app.example/email/01234567-89abcdef-01234567-89abcdef");
    expect(result.warnings).toEqual([]);
  });

  it("renders the built-in sign-off without an image when no logo is set, and with it when one is", async () => {
    const input = { post: post(), revision: revision("# Hi\n\nbody"), images: [] };
    const bare = await render(input, config, { ...defaultBranding(), name: "Field Notes" });
    // No <img src=""> in the email, and so none on the permanent archive page (I3).
    expect(bare.html).not.toMatch(/<img[^>]*class="logo"/);
    expect(bare.html).not.toMatch(/src=""/);
    expect(bare.html).toContain("Field Notes");

    const logoUrl = "https://media.example/branding/logo?v=1";
    const signed = await render(input, config, {
      ...defaultBranding(),
      name: "Field Notes",
      logoUrl,
    });
    expect(signed.html).toMatch(
      /<img[^>]*class="logo"[^>]*src="https:\/\/media\.example\/branding\/logo\?v=1"/,
    );
    expect(signed.html).toMatch(/<img[^>]*alt="Field Notes"/);
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
      template: "<div>{{ .Post.Body }}</div>", // no unsubscribe → invalid
      name: "",
      tagline: "",
      logoUrl: "",
      address: "",
      senderName: "",
    };
    const result = await render(
      { post: post(), revision: revision("hi"), images: [] },
      config,
      branding,
    );
    // Defense in depth: an unsubscribe-less template can never ship (I2).
    expect(result.html).toContain(UNSUB_SENTINEL);
    expect(result.warnings.join(" ")).toMatch(
      /^The email template can’t be used, so this shows the default template\. Every email must carry an unsubscribe link\./,
    );
  });
});

describe("email-only regions the HTML parser rearranges", () => {
  const input = { post: post(), revision: revision("POSTBODY"), images: [] };
  const withTemplate = (template: string) =>
    render(input, config, { ...defaultBranding(), template });

  it("falls back to the default when a table pushes the post into a region, so the archive keeps the post", async () => {
    // Valid as text, but the parser moves the post ahead of the <table>, inside the region.
    const result = await withTemplate(
      '{{ if .IsEmail }}<table><tr><td><a href="{{ .Email.UnsubscribeURL }}">u</a></td></tr>{{ end }}{{ .Post.Body }}</table>',
    );
    expect(result.warnings.join(" ")).toMatch(
      /doesn’t wrap whole elements, so this shows the default template\./,
    );
    expect(result.html).toBe((await withTemplate(DEFAULT_EMAIL_TEMPLATE)).html);
    expect(omitEmailOnly(result.html)).toContain("POSTBODY");
  });

  it("falls back to the default when a region tag sits inside an attribute", async () => {
    const result = await withTemplate(
      '{{ .Post.Body }}<a title="{{ if .IsEmail }}">x</a><a href="{{ .Email.UnsubscribeURL }}">u</a>{{ end }}',
    );
    expect(result.warnings.join(" ")).toMatch(/shows the default template/);
  });

  it("renders the built-in template's own region whole, since the fallback trusts it", async () => {
    expect(emailOnlyRegionsWhole((await withTemplate(DEFAULT_EMAIL_TEMPLATE)).html)).toBe(true);
  });

  it("keeps a region that wraps whole elements, even inside a table cell", async () => {
    const result = await withTemplate(
      '{{ .Post.Body }}<table><tr><td>{{ if .IsEmail }}<a href="{{ .Email.UnsubscribeURL }}">u</a><br>{{ end }}</td></tr></table>',
    );
    expect(result.warnings.join(" ")).not.toMatch(/shows the default template/);
    expect(omitEmailOnly(result.html)).toContain("POSTBODY");
    expect(omitEmailOnly(result.html)).not.toContain(">u</a>");
  });
});

// The email names the publication as the reader pages do: the publisher's name, else none
// at all, never a made-up one, and never the sending address's name, which is the sender's.
describe("the publication name in the email (SPEC §9)", () => {
  const input = () => ({ post: post(), revision: revision("# Hi\n\nbody"), images: [] });
  const signOffName = (html: string) => /<div class="name"[^>]*>([^<]*)<\/div>/.exec(html)?.[1];

  function brandingFrom(fromAddress: string, name = "") {
    const cfg = { ...config, fromAddress };
    const settings = {
      ...DEFAULT_SETTINGS,
      publication: { ...DEFAULT_SETTINGS.publication, name },
    };
    return { cfg, branding: resolveBranding(settings, cfg) };
  }

  async function emailFrom(fromAddress: string, name = ""): Promise<string> {
    const { cfg, branding } = brandingFrom(fromAddress, name);
    return (await render(input(), cfg, branding)).html;
  }

  it("signs off with no name while the publisher has set none, whatever the sending address carries", async () => {
    for (const from of [
      "news@send.example",
      "<news@send.example>",
      '"Birds Weekly" <news@send.example>',
    ]) {
      const html = await emailFrom(from);
      expect(signOffName(html), from).toBe("");
      expect(html, from).not.toContain("Birds Weekly");
    }
  });

  it("signs off with the publisher's name", async () => {
    expect(signOffName(await emailFrom("Other <news@send.example>", "Field Notes"))).toBe(
      "Field Notes",
    );
  });

  it("carries the sender's display name beside the render: the publication's name over a bare address, a name in the address over it, and none with neither", () => {
    expect(brandingFrom("news@send.example", "Field Notes").branding.senderName).toBe(
      "Field Notes",
    );
    expect(brandingFrom("Other <news@send.example>", "Field Notes").branding.senderName).toBe(
      "Other",
    );
    expect(brandingFrom("news@send.example").branding.senderName).toBe("");
  });
});
