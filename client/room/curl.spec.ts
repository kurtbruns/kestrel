import { describe, expect, it } from "vitest";
import type { ReferenceEntry } from "../../shared/reference";
import { curlCommand } from "./curl";

const route = (over: Partial<ReferenceEntry>): ReferenceEntry => ({
  method: "GET",
  path: "/posts",
  access: "admin",
  resource: "posts",
  summary: "",
  ...over,
});
const origin = "https://news.example.com";

describe("curlCommand", () => {
  it("a GET on the admin tier carries the Access service token pair once deployed", () => {
    expect(curlCommand(route({}), origin, "access")).toBe(
      [
        'curl "https://news.example.com/posts"',
        '  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"',
        '  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"',
      ].join(" \\\n"),
    );
  });

  it("locally, the dev token instead", () => {
    expect(curlCommand(route({}), origin, "dev")).toBe(
      ['curl "https://news.example.com/posts"', '  -H "Authorization: Bearer $TOKEN"'].join(
        " \\\n",
      ),
    );
  });

  it("names the method and sends the example body as JSON, quoting it for the shell", () => {
    const cmd = curlCommand(
      route({ method: "POST", path: "/posts", example: { request: { subject: "Owl's day" } } }),
      origin,
      "dev",
    );
    expect(cmd).toBe(
      [
        'curl -X POST "https://news.example.com/posts"',
        '  -H "Authorization: Bearer $TOKEN"',
        '  -H "Content-Type: application/json"',
        `  -d '{"subject":"Owl'\\''s day"}'`,
      ].join(" \\\n"),
    );
  });

  it("keeps :params as the placeholders to fill, and drops the pattern syntax a URL never carries", () => {
    const path = (p: string) =>
      curlCommand(route({ path: p, access: "public" }), origin, "dev")?.split("\n")[0];
    expect(path("/sends/:id/cancel")).toBe('curl "https://news.example.com/sends/:id/cancel"');
    expect(path("/media/:key(.*)")).toBe('curl "https://news.example.com/media/:key"');
    expect(path("/archive{/}?")).toBe('curl "https://news.example.com/archive"');
    expect(path("{/}?")).toBe('curl "https://news.example.com/"');
  });

  it("puts a required query parameter on the URL as a placeholder, and leaves optional ones off", () => {
    const cmd = curlCommand(
      route({
        path: "/confirm",
        access: "public",
        query: [
          { name: "token", description: "", required: true },
          { name: "lang", description: "" },
        ],
      }),
      origin,
      "dev",
    );
    expect(cmd).toBe('curl "https://news.example.com/confirm?token=:token"');
  });

  it("a public route carries no credential, and a webhook gets no command at all", () => {
    expect(curlCommand(route({ path: "/subscribe", access: "public" }), origin, "access")).toBe(
      'curl "https://news.example.com/subscribe"',
    );
    expect(curlCommand(route({ path: "/webhooks/ses", access: "webhook" }), origin, "access")).toBe(
      null,
    );
  });
});
