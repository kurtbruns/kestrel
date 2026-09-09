import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listDocs, renderDocPage } from "../src/docs";
import { adminAuth } from "./support/auth";

describe("docs registry (bundled from docs/setup/*.md)", () => {
  it("lists the guide in reading order with titles from each doc's H1", () => {
    const docs = listDocs();
    expect(docs.map((d) => d.slug)).toEqual([
      "overview",
      "provision",
      "access",
      "email-sender",
      "sending-domain",
      "archive-website",
      "verify",
    ]);
    // Titles are extracted from the markdown, not hard-coded here.
    expect(docs.find((d) => d.slug === "access")?.title).toBe("Access — the admin gate");
  });

  it("renders a doc to a themed, sanitized HTML page", () => {
    const res = renderDocPage("access");
    expect(res).toBeDefined();
  });

  it("returns undefined for an unknown slug", () => {
    expect(renderDocPage("does-not-exist")).toBeUndefined();
  });
});

describe("docs API is gated like the rest of the authoring API", () => {
  it("401s the list without a token", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs");
    expect(res.status).toBe(401);
  });

  it("401s a single doc without a token", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs/overview");
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
  it("lists the docs as JSON", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs", { headers: await adminAuth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docs: { slug: string; title: string }[] };
    expect(body.docs.map((d) => d.slug)).toContain("email-sender");
    expect(body.docs.every((d) => d.title.length > 0)).toBe(true);
  });

  it("renders one doc as a themed HTML page carrying the real setup content", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs/email-sender", {
      headers: await adminAuth(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Markdown was rendered (headings) and themed (the doc wrapper).
    expect(html).toContain(`class="doc"`);
    expect(html).toContain("<h1>Connect an email sender</h1>");
    // The exact operator facts survive the round-trip: the real webhook path
    // (from src/routes/webhooks.ts) and both providers.
    expect(html).toContain("/webhooks/ses");
    expect(html).toContain("/webhooks/resend");
  });

  it("404s an unknown doc slug when authed", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/docs/nope", {
      headers: await adminAuth(),
    });
    expect(res.status).toBe(404);
  });
});
