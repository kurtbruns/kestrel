/// <reference types="vite/client" />
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import readme from "../docs/README.md";
import { type DocsResponse, headingAnchors } from "../shared/docs";
import { bundledPages, renderDocs } from "../src/docs";
import { AUTH, base } from "./support/http";

describe("docs registry (docs/README.md and the section folders it lists)", () => {
  it("renders the guide in the README's order with titles from each doc's H1 and an HTML fragment", () => {
    const { docs } = renderDocs();
    expect(docs.map((d) => `${d.section}/${d.slug}`)).toEqual([
      "get-started/deploy",
      "get-started/access",
      "get-started/ses",
      "get-started/verify",
      "get-started/go-live",
      "guides/connect-claude",
      "guides/try-locally",
      "guides/notifications",
      "guides/rate-limit",
      "guides/upgrade",
      "reference/configuration",
      "reference/sending-domain-dns",
      "reference/import-format",
    ]);
    // Titles are extracted from the markdown, not hard-coded here.
    expect(docs.find((d) => d.slug === "access")?.title).toBe("Lock the dashboard with Access");
    // Each doc renders to a non-empty fragment (headings), not a full HTML page.
    for (const d of docs) {
      expect(d.html).toContain("<h");
      expect(d.html).not.toContain("<!doctype");
    }
  });

  it("reads the landing page from the README: its title, intro, and sections", () => {
    const { landing } = renderDocs();
    expect(landing.title).toBe("Set up and run Kestrel");
    expect(landing.intro).toMatch(/^<p>.+<\/p>/s);
    expect(landing.sections.map((s) => [s.id, s.title, s.numbered])).toEqual([
      ["get-started", "Get started", true],
      ["guides", "Guides", false],
      ["reference", "Reference", false],
    ]);
    for (const s of landing.sections) {
      expect(s.blurb, s.title).toMatch(/^<p>.+<\/p>/s);
    }
  });

  it("lists every bundled page in the README exactly once, each in its own section's folder", () => {
    // The README is written by hand, so a page added without listing it, listed twice,
    // listed under another section's heading, or linked by a path no import provides would
    // quietly drop out of the guide or land in the wrong place.
    const { landing, docs } = renderDocs();
    const listed = [...readme.matchAll(/\]\(([a-z0-9-]+\/\d{2}-[a-z0-9-]+\.md)\)/g)].map(
      ([, path]) => path,
    );
    expect(listed.sort()).toEqual(bundledPages().sort());
    expect(new Set(docs.map((d) => d.slug)).size).toBe(docs.length);
    const ids = landing.sections.map((s) => s.id);
    for (const d of docs) {
      expect(ids, d.slug).toContain(d.section);
    }
    // A section's pages are one run, so Previous/Next and the index agree on the order.
    const seen = docs.map((d) => ids.indexOf(d.section));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("turns every link between guide pages into the doc's in-app route", () => {
    // The Markdown links pages by relative path (`02-deploy.md`) so the same file works on
    // GitHub; the Worker rewrites each to `#/docs/<slug>`. A link left as a `.md` path names
    // a file that is not a doc (a typo, or a page since renamed), and would 404 in the app.
    const { docs } = renderDocs();
    const slugs = new Set(docs.map((d) => d.slug));
    for (const d of docs) {
      expect(d.html, d.slug).not.toMatch(/href="[^"]*\.md[#"]/);
      for (const [, slug] of d.html.matchAll(/href="#\/docs\/([^"/]+)(?:\/[^"]*)?"/g)) {
        expect(slugs, `${d.slug} links to ${slug}`).toContain(slug);
      }
    }
    const start = docs.find((d) => d.slug === "deploy");
    expect(start?.html).toContain('href="#/docs/ses"');
    expect(start?.html).toContain('href="#/docs/configuration"');
    // An anchor rides along as the route's last segment, for the room to scroll to.
    expect(start?.html).toContain('href="#/docs/sending-domain-dns/choose-your-sending-name"');
  });

  it("lands every link to a heading, from the guide or the editor, on a heading that exists", () => {
    // The editor names a doc's headings by the anchor rule, so a link to `#/docs/<slug>/<anchor>`
    // breaks silently when the heading is renamed or renumbered: the room opens the doc at its
    // top. The editor's links are read from its source, specs left out.
    const { docs } = renderDocs();
    const anchors = new Map(docs.map((d) => [d.slug, anchorsIn(d.html)]));
    const links: [from: string, slug: string, anchor: string][] = [];
    for (const d of docs) {
      for (const [, slug, anchor] of d.html.matchAll(/href="#\/docs\/([a-z0-9-]+)\/([^"]+)"/g)) {
        links.push([d.slug, slug as string, anchor as string]);
      }
    }
    for (const [path, source] of Object.entries(editorSources)) {
      for (const [, slug, anchor] of source.matchAll(/#\/docs\/([a-z0-9-]+)\/([a-z0-9-]+)/g)) {
        links.push([path, slug as string, anchor as string]);
      }
    }
    for (const [from, slug, anchor] of links) {
      expect(anchors.get(slug), `${from} links to ${slug}/${anchor}`).toContain(anchor);
    }
    // The scan reads the editor's source, so it finds the link Settings makes under the From
    // address; finding none would mean the scan reads nothing.
    expect(links).toContainEqual([
      "../client/settings/deploy.ts",
      "ses",
      "3-receive-replies-at-your-from-address",
    ]);
  });
});

// The editor's modules as text, for the links they make. Vite reads them at build time.
const editorSources = import.meta.glob<string>(["../client/**/*.ts", "!../client/**/*.spec.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A doc's heading anchors as the editor names them, from the fragment's heading text. */
function anchorsIn(fragment: string): string[] {
  const texts = [...fragment.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(([, inner]) =>
    decodeEntities((inner as string).replace(/<[^>]+>/g, "")),
  );
  return headingAnchors(texts);
}

// The heading text the editor reads is the DOM's, with every entity decoded; the rule drops
// punctuation, so a stray entity left encoded would put its letters into the anchor.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

describe("docs API is gated like the rest of the authoring API", () => {
  it("401s the guide without a token", async () => {
    const res = await SELF.fetch(`${base}/api/docs`);
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await SELF.fetch(`${base}/api/docs`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
});

describe("docs API serves the setup content when authed", () => {
  it("returns the whole guide as sanitized HTML fragments in reading order", async () => {
    const res = await SELF.fetch(`${base}/api/docs`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocsResponse;
    expect(body.docs.every((d) => d.title.length > 0)).toBe(true);

    // Markdown was rendered (the doc's H1) and the exact operator facts survive: the SES
    // webhook's real path (from src/routes/webhooks.ts).
    const ses = body.docs.find((d) => d.slug === "ses");
    expect(ses?.html).toContain("Connect Amazon SES");
    expect(ses?.html).toContain("/webhooks/ses");
    // Fragments are sanitized (no scripts) and carry no page wrapper.
    for (const d of body.docs) {
      expect(d.html).not.toContain("<script");
      expect(d.html).not.toContain("<!doctype");
    }
  });
});
