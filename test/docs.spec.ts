import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import readme from "../docs/README.md";
import type { DocsResponse } from "../shared/docs";
import { bundledPages, renderDocs } from "../src/docs";
import { adminAuth } from "./support/auth";

describe("docs registry (docs/README.md and the section folders it lists)", () => {
  it("renders the guide in the README's order with titles from each doc's H1 and an HTML fragment", () => {
    const { docs } = renderDocs();
    expect(docs.map((d) => `${d.section}/${d.slug}`)).toEqual([
      "get-started/overview",
      "get-started/deploy",
      "get-started/access",
      "get-started/resend",
      "get-started/verify",
      "get-started/go-live",
      "guides/connect-claude",
      "guides/ses",
      "guides/notifications",
      "guides/archive-website",
      "guides/rate-limit",
      "guides/staging",
      "guides/upgrade",
      "reference/configuration",
      "reference/sending-domain-dns",
      "reference/admin-gate",
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
    expect(landing.intro).toContain('href="#/docs/overview"'); // the intro's link, rewritten
    expect(landing.sections.map((s) => [s.id, s.title, s.numbered])).toEqual([
      ["get-started", "Get started", true],
      ["guides", "More guides", false],
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
    // The Overview is linked twice: once in the intro, once as the first step.
    expect(listed.slice(1).sort()).toEqual(bundledPages().sort());
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
    const start = docs.find((d) => d.slug === "overview");
    expect(start?.html).toContain('href="#/docs/deploy"');
    expect(start?.html).toContain('href="#/docs/ses"');
    // An anchor rides along as the route's last segment, for the room to scroll to.
    expect(start?.html).toContain('href="#/docs/sending-domain-dns/two-hard-rules"');
  });

  it("keeps the titles the pages cross-reference each other by", () => {
    // Some pages still point at each other by title in bold (**Deploy the app**) rather than
    // by link. This pins those titles, so retitling a page fails here and its pointers get
    // updated with it.
    const titles = new Set(renderDocs().docs.map((d) => d.title));
    for (const ref of [
      "Overview",
      "Deploy the app",
      "Lock the dashboard with Access",
      "Connect Resend",
      "Verify it works",
      "Go live",
      "Connect Claude to the API",
      "Use Amazon SES instead of Resend",
      "Notifications through Cloudflare's email",
      "Put the archive on your website",
      "Rate-limit the subscribe form",
      "Add a staging environment",
      "Upgrade to a new release",
      "Configuration",
      "Sending-domain DNS",
      "How the admin gate works",
    ]) {
      expect(titles).toContain(ref);
    }
  });
});

describe("docs API is gated like the rest of the authoring API", () => {
  it("401s the guide without a token", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs");
    expect(res.status).toBe(401);
  });

  it("401s with a wrong token", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
});

describe("docs API serves the setup content when authed", () => {
  it("returns the whole guide as sanitized HTML fragments in reading order", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs", { headers: await adminAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocsResponse;
    expect(body.docs.every((d) => d.title.length > 0)).toBe(true);

    // Markdown was rendered (the doc's H1) and the exact operator facts survive: each
    // provider's real webhook path (from src/routes/webhooks.ts).
    const resend = body.docs.find((d) => d.slug === "resend");
    expect(resend?.html).toContain("Connect Resend");
    expect(resend?.html).toContain("/webhooks/resend");
    const ses = body.docs.find((d) => d.slug === "ses");
    expect(ses?.html).toContain("/webhooks/ses");
    // Fragments are sanitized (no scripts) and carry no page wrapper.
    for (const d of body.docs) {
      expect(d.html).not.toContain("<script");
      expect(d.html).not.toContain("<!doctype");
    }
  });
});
