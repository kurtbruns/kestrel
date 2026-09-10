import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const BASE = "https://kestrel.test";

async function getSettings() {
  const res = await SELF.fetch(`${BASE}/api/settings`, { headers: await adminAuth() });
  return {
    res,
    body: (await res.json()) as {
      settings: { testRecipients: string[] };
      deployment: Record<string, unknown>;
    },
  };
}

async function putSettings(patch: unknown) {
  return SELF.fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { ...(await adminAuth()), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

describe("settings API is gated like the rest of the authoring API", () => {
  it("401s GET without a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/settings`);
    expect(res.status).toBe(401);
  });
  it("401s PUT without a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testRecipients: ["x@example.com"] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("settings surface", () => {
  it("returns defaults + a read-only deployment reflection (no secrets)", async () => {
    const { res, body } = await getSettings();
    expect(res.status).toBe(200);
    expect(body.settings.testRecipients).toEqual([]);
    // Reflects the env-resolved config (fake transport in tests)…
    expect(body.deployment.provider).toBe("fake");
    expect(typeof body.deployment.fromAddress).toBe("string");
    expect(body.deployment.accessConfigured).toBe(false);
    // …but never leaks a secret or credential.
    const keys = Object.keys(body.deployment);
    for (const leaked of [
      "awsAccessKeyId",
      "awsSecretAccessKey",
      "resendApiKey",
      "devAuthSecret",
      "accessAud",
    ]) {
      expect(keys).not.toContain(leaked);
    }
  });

  it("persists test recipients (normalized + deduped) and reflects them back", async () => {
    const put = await putSettings({
      testRecipients: ["You@Example.com", "you@example.com", "team@example.com"],
    });
    expect(put.status).toBe(200);
    const { body } = await getSettings();
    expect(body.settings.testRecipients).toEqual(["you@example.com", "team@example.com"]);
  });

  it("rejects an invalid address with 400", async () => {
    const res = await putSettings({ testRecipients: ["not-an-email"] });
    expect(res.status).toBe(400);
  });

  it("rejects a non-list testRecipients with 400", async () => {
    const res = await putSettings({ testRecipients: "you@example.com" });
    expect(res.status).toBe(400);
  });
});
