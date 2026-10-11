import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_JOURNEYS, readerPagePath } from "../shared/reader_pages";
import { updateSettings } from "../src/db/settings";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { resetDatabase } from "./support/fixtures";
import { AUTH, base } from "./support/http";

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
  "reading/landing-empty": ["No posts yet — subscribe to get the first one."],
  "reading/archive-empty": ["No posts yet."],
  "reading/not-found": ["Nothing here yet"],
};

beforeEach(async () => {
  await resetDatabase();
  await updateSettings(env.DB, { publication: { name: publication } });
  clearFakeOutbox();
});

async function preview(journey: string, state: string): Promise<Response> {
  return SELF.fetch(`${base}${readerPagePath(journey, state)}`, { headers: AUTH });
}

describe("reader page previews (SPEC §5)", () => {
  it("are admin-only", async () => {
    const res = await SELF.fetch(`${base}${readerPagePath("subscribe", "form")}`);
    expect(res.status).toBe(401);
  });

  it("render every page and state in the catalog as a reader gets it, acting on nothing", async () => {
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
        // The page exactly as a reader gets it: no test strip, and, since a preview is the
        // deployed page, no local dev dashboard shortcut.
        expect(body, name).not.toContain('class="r-banner"');
        expect(body, name).not.toContain('class="r-dev"');
      }
    }
    // Nothing was subscribed, confirmed, or mailed. A GET that only calls builders can't, so
    // this is a canary for a builder that one day writes; what keeps a preview from acting
    // is the form-action header above and the client frame's sandbox.
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("answers 404 for a page the catalog lacks", async () => {
    expect((await preview("subscribe", "nope")).status).toBe(404);
    expect((await preview("nope", "form")).status).toBe(404);
  });
});
