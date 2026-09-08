import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BEARER = "test-bearer-token"; // matches vitest.config.ts binding

describe("auth on the admin surface", () => {
  it("rejects /api/whoami with no token (401)", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("admits a valid bearer token (200) and reports the principal", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: { kind: "service" } });
  });

  it("keeps /health public (200, no token)", async () => {
    const res = await SELF.fetch("https://kestrel.test/health");
    expect(res.status).toBe(200);
  });
});
