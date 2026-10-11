import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_JOURNEYS, readerPagePath } from "../shared/reader_pages";
import { updateSettings } from "../src/db/settings";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { adminAuth } from "./support/auth";

const base = "https://kestrel.test";
const publication = "Marsh Lane";

/** What each page shows that no other does, so a preview can't answer with the wrong one. */
const SHOWS: Record<string, string[]> = {
  "subscribe/form": [`Subscribe to ${publication}`, 'name="email"'],
  "subscribe/check-inbox": ["Almost there"],
  "subscribe/not-an-email": ["That doesn’t look like an email"],
  "confirm/ready": [
    `Confirm your subscription to ${publication}`,
    "<strong>reader@example.com</strong>",
  ],
  "confirm/confirmed": ["You’re subscribed", "<strong>reader@example.com</strong>"],
  "confirm/expired": ["This link has expired", "Send a new link"],
  "confirm/invalid": ["This link is invalid", "Subscribe again"],
  "unsubscribe/ask": [`Unsubscribe from ${publication}?`, "<strong>reader@example.com</strong>"],
  "unsubscribe/done": ["You’re unsubscribed", "<strong>reader@example.com</strong>"],
  "unsubscribe/invalid": ["This link is invalid", "It may be incomplete."],
  "reading/landing": ["Latest post", "The starlings are back", "Browse the full archive"],
  "reading/archive": ["The starlings are back", "What the river kept"],
  "reading/post": ["<title>The starlings are back</title>", 'class="k-mast"'],
  "reading/not-found": ["Nothing here yet"],
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM subscribers").run();
  await updateSettings(env.DB, { publication: { name: publication } });
  clearFakeOutbox();
});

async function preview(journey: string, state: string): Promise<Response> {
  return SELF.fetch(`${base}${readerPagePath(journey, state)}`, { headers: await adminAuth() });
}

describe("reader page previews (SPEC §5)", () => {
  it("are admin-only", async () => {
    const res = await SELF.fetch(`${base}${readerPagePath("subscribe", "form")}`);
    expect(res.status).toBe(401);
  });

  it("render every page and state in the catalog, under the preview strip, acting on nothing", async () => {
    const listed = READER_JOURNEYS.flatMap((j) => j.states.map((s) => `${j.id}/${s.id}`));
    // The catalog and this test name the same pages, so a page added to one is tested.
    expect(listed.sort()).toEqual(Object.keys(SHOWS).sort());
    for (const j of READER_JOURNEYS) {
      for (const s of j.states) {
        const name = `${j.id}/${s.id}`;
        const res = await preview(j.id, s.id);
        // 200 whatever the real page answers (an expired link is a 410).
        expect(res.status, name).toBe(200);
        expect(res.headers.get("cache-control"), name).toBe("no-store");
        expect(res.headers.get("x-robots-tag"), name).toBe("noindex");
        // Its forms submit nowhere, even opened in a tab of its own.
        expect(res.headers.get("content-security-policy"), name).toContain("form-action 'none'");
        const body = await res.text();
        for (const shown of SHOWS[name]!) {
          expect(body, name).toContain(shown);
        }
        expect(body, name).toContain(publication);
        // The strip is the body's first child, above the page's own masthead.
        expect(body, name).toMatch(/<body[^>]*>\s*<div class="r-banner" role="note">/);
        expect(body, name).toContain("Preview");
        // A preview is the deployed page, so local dev's dashboard shortcut stays off it.
        expect(body, name).not.toContain('class="r-dev"');
      }
    }
    // Nothing was subscribed, confirmed, or mailed.
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("puts the strip above the post page's column, outside the frozen content", async () => {
    const body = await (await preview("reading", "post")).text();
    expect(body.indexOf('class="r-banner"')).toBeLessThan(body.indexOf('class="k-mast"'));
    // The strip's stylesheet rides the head, beside the post page's own chrome.
    expect(body.indexOf(".r-banner-in")).toBeLessThan(body.indexOf("</head>"));
  });

  it("answers 404 for a page the catalog lacks", async () => {
    expect((await preview("subscribe", "nope")).status).toBe(404);
    expect((await preview("nope", "form")).status).toBe(404);
  });
});
