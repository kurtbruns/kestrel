import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base } from "./support/http";

describe("health", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "kestrel" });
  });

  it("unknown route returns 404", async () => {
    const res = await SELF.fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
