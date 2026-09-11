import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isHumanAllowed } from "../src/auth/access";
import { mintDevToken, verifyDevToken } from "../src/auth/dev_token";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { adminAuth, DEV_SECRET } from "./support/auth";

describe("Access admin allowlist", () => {
  it("admits anyone when no allowlist is configured", () => {
    expect(isHumanAllowed("anyone@example.com", undefined)).toBe(true);
    expect(isHumanAllowed("anyone@example.com", [])).toBe(true);
  });
  it("admits only allowlisted emails (case-insensitive) when configured", () => {
    const allow = ["you@example.com", "team@example.com"];
    expect(isHumanAllowed("YOU@example.com", allow)).toBe(true);
    expect(isHumanAllowed("intruder@example.com", allow)).toBe(false);
  });
});

describe("auth on the admin surface", () => {
  it("rejects /api/whoami with no token (401)", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami");
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret (401)", async () => {
    const token = await mintDevToken("some-other-secret", { email: "x@example.com" });
    const res = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("admits a human dev token (200) and reports the principal + mode", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: await adminAuth({ email: "human@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principal: { kind: "human", email: "human@example.com" },
      auth: { mode: "dev" },
    });
  });

  it("admits a service dev token (200) with no email", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: await adminAuth({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: { kind: "service" }, auth: { mode: "dev" } });
  });

  it("keeps /health public (200, no token)", async () => {
    const res = await SELF.fetch("https://kestrel.test/health");
    expect(res.status).toBe(200);
  });
});

describe("dev-token bootstrap endpoint", () => {
  it("mints a working human token by default", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/dev/token");
    expect(res.status).toBe(200);
    const { token, kind } = (await res.json()) as { token: string; kind: string };
    expect(kind).toBe("human");
    const who = await SELF.fetch("https://kestrel.test/api/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(who.status).toBe(200);
  });

  it("mints a service token when asked", async () => {
    const res = await SELF.fetch("https://kestrel.test/api/dev/token?kind=service");
    const { kind } = (await res.json()) as { kind: string };
    expect(kind).toBe("service");
  });
});

describe("dev credential is inert in a deployed-shaped env", () => {
  const deployed = {
    PROVIDER: "ses",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud-tag",
    DEV_AUTH_SECRET: DEV_SECRET,
    APP_ORIGIN: "https://newsletter.example.com",
    ARCHIVE_ORIGIN: "https://example.com",
    ARCHIVE_BASE_PATH: "/archive",
    MEDIA_PUBLIC_BASE: "https://media.example.com",
    SENDING_DOMAIN: "send.example.com",
    FROM_ADDRESS: "News <news@send.example.com>",
    AWS_REGION: "us-east-1",
  } as unknown as AppEnv;

  it("does not resolve devAuthSecret when provider is real and Access is configured", () => {
    expect(getConfig(deployed).devAuthSecret).toBeUndefined();
  });

  // Pins the AND semantics: a real provider with Access not yet configured must
  // still drop the secret. This case would leak under an accidental `||`.
  it("does not resolve devAuthSecret for a real provider even if Access is unset", () => {
    const halfDeployed = {
      ...deployed,
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    } as unknown as AppEnv;
    expect(getConfig(halfDeployed).devAuthSecret).toBeUndefined();
  });

  it("resolves devAuthSecret only in a dev-shaped env (fake + no Access)", () => {
    const dev = {
      ...deployed,
      PROVIDER: "fake",
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    } as unknown as AppEnv;
    expect(getConfig(dev).devAuthSecret).toBe(DEV_SECRET);
  });

  it("still verifies a token in isolation (guard lives in config, not the verifier)", async () => {
    const token = await mintDevToken(DEV_SECRET, { email: "human@example.com" });
    expect(await verifyDevToken(token, DEV_SECRET)).toEqual({
      kind: "human",
      email: "human@example.com",
    });
  });
});
