/// <reference types="vite/client" />
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import troubleshooting from "../docs/publishing/06-troubleshooting.md";
import publishingIndex from "../docs/publishing/README.md";
import selfHostingIndex from "../docs/README.md";
import { type DocsResponse, headingAnchors } from "../shared/docs";
import { bundledPages, docMarkdown, markdownLinksForAgents, renderDocs } from "../src/docs";
import { AUTH, base } from "./support/http";

describe("docs registry (the two sets' index files and the pages they list)", () => {
  it("renders the docs in the indexes' order, Publishing first, with titles from each doc's H1 and an HTML fragment", () => {
    const { docs } = renderDocs();
    expect(docs.map((d) => `${d.set}/${d.section}/${d.slug}`)).toEqual([
      "publishing/set-up-your-publication/name-your-publication",
      "publishing/set-up-your-publication/check-your-setup",
      "publishing/set-up-your-publication/your-list",
      "publishing/set-up-your-publication/write-a-post",
      "publishing/set-up-your-publication/share-your-subscribe-link",
      "publishing/go-further/email-template",
      "publishing/go-further/connect-claude",
      "publishing/rules-and-troubleshooting/sending-rules",
      "publishing/rules-and-troubleshooting/troubleshooting",
      "self-hosting/get-started/deploy",
      "self-hosting/get-started/access",
      "self-hosting/get-started/aws-account",
      "self-hosting/get-started/ses",
      "self-hosting/get-started/production-access",
      "self-hosting/get-started/verify",
      "self-hosting/get-started/go-live",
      "self-hosting/guides/allow-claude",
      "self-hosting/guides/automate",
      "self-hosting/guides/notifications",
      "self-hosting/guides/rate-limit",
      "self-hosting/guides/as-your-list-grows",
      "self-hosting/guides/upgrade",
      "self-hosting/reference/configuration",
      "self-hosting/reference/sending-domain-dns",
    ]);
    // Titles are extracted from the markdown, not hard-coded here.
    expect(docs.find((d) => d.slug === "access")?.title).toBe("Lock the dashboard with Access");
    // Each doc renders to a non-empty fragment (headings), not a full HTML page.
    for (const d of docs) {
      expect(d.html).toContain("<h");
      expect(d.html).not.toContain("<!doctype");
    }
  });

  it("reads each set's landing from its index file: its title, intro, and sections", () => {
    const { sets } = renderDocs();
    expect(sets.map((s) => [s.id, s.name, s.title])).toEqual([
      ["publishing", "Publishing", "Publishing with Kestrel"],
      ["self-hosting", "Self-hosting", "Self-hosting Kestrel"],
    ]);
    expect(sets.map((s) => s.sections.map((sec) => [sec.id, sec.title, sec.numbered]))).toEqual([
      [
        ["set-up-your-publication", "Set up your publication", true],
        ["go-further", "Go further", false],
        ["rules-and-troubleshooting", "Rules and troubleshooting", false],
      ],
      [
        ["get-started", "Get started", true],
        ["guides", "Guides", false],
        ["reference", "Reference", false],
      ],
    ]);
    for (const s of sets) {
      expect(s.intro, s.id).toMatch(/^<p>.+<\/p>/s);
    }
    // A link in an index never names an empty slug: a same-page anchor resolves against the
    // set's own route.
    for (const set of sets) {
      for (const html of [set.intro, ...set.sections.map((sec) => sec.blurb)]) {
        expect(html, set.id).not.toContain('href="#/docs//');
      }
    }
    // Each intro links the other set's index, which the room serves at the set's id.
    expect(sets[0]?.intro).toContain('href="#/docs/self-hosting"');
    expect(sets[1]?.intro).toContain('href="#/docs/publishing"');
  });

  it("lists every bundled page in exactly one index once, Publishing's pages in its folder", () => {
    // The indexes are written by hand, so a page added without listing it, listed twice, or
    // linked by a path no import provides would quietly drop out of the docs.
    const { sets, docs } = renderDocs();
    const listed = [
      ...[...publishingIndex.matchAll(/\]\((\d{2}-[a-z0-9-]+\.md)\)/g)].map(
        ([, f]) => `publishing/${f}`,
      ),
      ...[...selfHostingIndex.matchAll(/\]\(([a-z0-9-]+\/\d{2}-[a-z0-9-]+\.md)\)/g)].map(
        ([, path]) => path,
      ),
    ];
    expect(listed.sort()).toEqual(bundledPages().sort());
    expect(docs.filter((d) => d.set === "publishing").length).toBe(
      bundledPages().filter((p) => p.startsWith("publishing/")).length,
    );
    // A slug names a page's route and its Markdown, and a set's id names its index's, so all
    // of them are unique together.
    const names = [...docs.map((d) => d.slug), ...sets.map((s) => s.id)];
    expect(new Set(names).size).toBe(names.length);
    for (const d of docs) {
      const set = sets.find((s) => s.id === d.set);
      expect(
        set?.sections.map((sec) => sec.id),
        d.slug,
      ).toContain(d.section);
    }
    // A set's pages are one run, and a section's within it, so Previous/Next and the index agree.
    const order = docs.map((d) => `${d.set}/${d.section}`);
    const runs = order.filter((key, i) => key !== order[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
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
    // Across sets: a publisher page to the setup guide, and back.
    expect(docs.find((d) => d.slug === "your-list")?.html).toContain(
      'href="#/docs/as-your-list-grows"',
    );
    expect(docs.find((d) => d.slug === "connect-claude")?.html).toContain(
      'href="#/docs/allow-claude"',
    );
  });

  it("opens the page Settings and the dashboard send the publisher to for production access", () => {
    const { docs } = renderDocs();
    expect(editorSources["../client/provider_status.ts"]).toContain('"#/docs/production-access"');
    expect(docs.find((d) => d.slug === "production-access")?.title).toBe(
      "Request production access",
    );
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
      "8-receive-replies-at-your-from-address",
    ]);
  });
});

describe("Troubleshooting quotes the app's own words", () => {
  it("finds every quote and bold label the page shows as the app's words in the app's source", () => {
    // The page points at what the screen says rather than restating it, so what it does quote
    // (a message in "…", a label in bold) has to stay the app's words when the app changes.
    const words = appWordsIn(troubleshooting);
    const source = Object.values(appSources).map(plainQuotes).join("\n");
    for (const w of words) {
      expect(
        source.includes(w),
        `"${w}" is not in client/, shared/, src/, or the kestrel client`,
      ).toBe(true);
    }
    // A quote and a label it names, so a scan that finds nothing can't pass.
    expect(words).toContain("Assume not sent");
    expect(words).toContain("via the API");
  });

  it("reads a quote and a bold label as the app's words, and a bold sentence as the page's own", () => {
    const md = [
      '**Lead in, the page\'s own.** Under **Settings → Notifications**, the line says "it’s held".',
      '`code "skipped"` and [a link](06-x.md#"skipped") and **Claude\'s changes read "via the API".**',
      "```\n**Fenced**\n```",
    ].join("\n");
    expect(appWordsIn(md).sort()).toEqual([
      "Notifications",
      "Settings",
      "it's held",
      "via the API",
    ]);
  });
});

describe("each doc as Markdown, for an agent (docMarkdown)", () => {
  it("serves a page's Markdown with its links pointed at the other docs' Markdown", () => {
    const md = docMarkdown("your-list") ?? "";
    expect(md).toMatch(/^# Bring your existing list/);
    expect(md).toContain("](your-list.md#the-file-format)");
    expect(md).toContain("](as-your-list-grows.md)");
    expect(md).not.toMatch(/\]\([^)]*\d{2}-[a-z0-9-]+\.md/);
  });

  it("serves a merged page under its former slug, which an earlier release's context or links may name", () => {
    expect(docMarkdown("import-format")).toBe(docMarkdown("your-list"));
    expect(docMarkdown("import-format")).toMatch(/^# Bring your existing list/);
    expect(docMarkdown("scheduling-and-sending")).toBe(docMarkdown("write-a-post"));
    expect(docMarkdown("after-a-send")).toBe(docMarkdown("troubleshooting"));
    expect(docMarkdown("try-locally")).toBe(docMarkdown("deploy"));
    expect(docMarkdown("working-with-claude")).toBe(docMarkdown("connect-claude"));
  });

  it("serves a set's index by its id, linking its pages and the other set", () => {
    const md = docMarkdown("publishing") ?? "";
    expect(md).toMatch(/^# Publishing with Kestrel/);
    expect(md).toContain("](your-list.md)");
    expect(md).toContain("](self-hosting.md)");
    expect(docMarkdown("self-hosting")).toContain("](publishing.md)");
  });

  it("leaves every link between docs resolvable, in every doc", () => {
    const { sets, docs } = renderDocs();
    const names = new Set([...docs.map((d) => d.slug), ...sets.map((s) => s.id)]);
    for (const name of names) {
      const md = docMarkdown(name) ?? "";
      for (const [, target] of md.matchAll(/\]\(([^)\s#:/]+)\.md(?:#[^)\s]*)?\)/g)) {
        expect(names, `${name} links to ${target}`).toContain(target);
      }
      // No relative link to a Markdown file is left unrewritten.
      expect(md, name).not.toMatch(/\]\((?:\.\.\/|[a-z-]+\/)[^)]*\.md/);
    }
    expect(docMarkdown("nope")).toBeNull();
  });

  it("leaves link syntax inside code as written", () => {
    const md = [
      "See [Deploy](../get-started/02-deploy.md#check-it).",
      "",
      "Write `[Deploy](02-deploy.md)` to link a page.",
      "",
      "```",
      "[Notifications](../guides/03-notifications.md)",
      "```",
    ].join("\n");
    const out = markdownLinksForAgents(md, "publishing/01-your-list.md");
    expect(out).toContain("See [Deploy](deploy.md#check-it).");
    expect(out).toContain("Write `[Deploy](02-deploy.md)` to link a page.");
    expect(out).toContain("[Notifications](../guides/03-notifications.md)\n```");
  });
});

// The editor's modules as text, for the links they make. Vite reads them at build time.
const editorSources = import.meta.glob<string>(["../client/**/*.ts", "!../client/**/*.spec.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// Every module whose words reach a publisher: the editor, the shared wire text, the Worker's
// messages (a send's conditions, a test's answer), and the kestrel client's. Specs and the
// editor's test server, which fakes messages, are left out.
const appSources = import.meta.glob<string>(
  [
    "../client/**/*.ts",
    "../shared/**/*.ts",
    "../src/**/*.ts",
    "../packages/kestrel/lib/**/*.mjs",
    "!../**/*.spec.ts",
    "!../client/test/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

// Typographic quotes and apostrophes as plain ones, since the app's source writes `’` and
// the docs write `'`.
function plainQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** What a page quotes as the app's words: each "…" quote, and each bold label, a bold
 *  `A → B` path naming each part. A bold phrase ending in a full stop is a sentence of the
 *  page's own, a lead-in or a decision, and code and link targets are never the app's words. */
function appWordsIn(md: string): string[] {
  const prose = plainQuotes(md)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/\]\([^)\s]*\)/g, "]");
  const quotes = [...prose.matchAll(/"([^"\n]+)"/g)].map(([, q]) => q as string);
  const labels = [...prose.matchAll(/\*\*([^*\n]+)\*\*/g)]
    .map(([, b]) => (b as string).trim())
    .filter((b) => !/[.!?]"?$/.test(b))
    .flatMap((b) => b.split(" → "));
  return [...new Set([...quotes, ...labels])];
}

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
  it("401s the docs, a doc's Markdown, and the reference's without a token", async () => {
    for (const path of ["/api/docs", "/api/docs/your-list.md", "/api/reference.md"]) {
      const res = await SELF.fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("401s with a wrong token", async () => {
    const res = await SELF.fetch(`${base}/api/docs`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
});

describe("docs API serves the docs when authed", () => {
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

  it("serves a doc, or a set's index, as Markdown, and 404s a name that is neither", async () => {
    const res = await SELF.fetch(`${base}/api/docs/sending-rules.md`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe(docMarkdown("sending-rules"));
    const index = await SELF.fetch(`${base}/api/docs/self-hosting.md`, { headers: AUTH });
    expect(await index.text()).toMatch(/^# Self-hosting Kestrel/);
    const missing = await SELF.fetch(`${base}/api/docs/nope.md`, { headers: AUTH });
    expect(missing.status).toBe(404);
  });
});
