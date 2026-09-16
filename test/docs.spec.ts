import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderDocs } from "../src/docs";
import { adminAuth } from "./support/auth";

describe("docs registry (bundled from docs/setup/*.md)", () => {
  it("renders the guide in reading order with titles from each doc's H1 and an HTML fragment", () => {
    const docs = renderDocs();
    expect(docs.map((d) => d.slug)).toEqual([
      "overview",
      "provision",
      "access",
      "email-sender",
      "sending-domain",
      "archive-website",
      "verify",
      "connect-claude",
    ]);
    // Titles are extracted from the markdown, not hard-coded here.
    expect(docs.find((d) => d.slug === "access")?.title).toBe("Access — the admin gate");
    // Each doc renders to a non-empty fragment (headings), not a full HTML page.
    for (const d of docs) {
      expect(d.html).toContain("<h");
      expect(d.html).not.toContain("<!doctype");
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
    const body = (await res.json()) as { docs: { slug: string; title: string; html: string }[] };
    expect(body.docs.map((d) => d.slug)).toContain("email-sender");
    expect(body.docs.every((d) => d.title.length > 0)).toBe(true);

    const sender = body.docs.find((d) => d.slug === "email-sender");
    expect(sender).toBeDefined();
    // Markdown was rendered (the doc's H1) and the exact operator facts survive:
    // the real webhook paths (from src/routes/webhooks.ts) and both providers.
    expect(sender?.html).toContain("Connect an email sender");
    expect(sender?.html).toContain("/webhooks/ses");
    expect(sender?.html).toContain("/webhooks/resend");
    // Fragments are sanitized (no scripts) and carry no page wrapper.
    for (const d of body.docs) {
      expect(d.html).not.toContain("<script");
      expect(d.html).not.toContain("<!doctype");
    }
  });
});
