import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const BASE = "https://kestrel.test";

async function getSettings() {
  const res = await SELF.fetch(`${BASE}/api/settings`, { headers: await adminAuth() });
  return {
    res,
    body: (await res.json()) as {
      settings: {
        testRecipients: string[];
        publication: {
          name: string;
          tagline: string;
          brandColor: string;
          brandTextColor: string;
          address: string;
          logoUrl: string;
        };
        emailTemplate: string;
      };
      deployment: Record<string, unknown>;
    },
  };
}

// A real 1x1 PNG for the logo-upload tests.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);
async function putLogo(bytes: Uint8Array, type: string) {
  const fd = new FormData();
  fd.append("file", new File([bytes], "logo", { type }));
  return SELF.fetch(`${BASE}/api/settings/logo`, {
    method: "POST",
    headers: { ...(await adminAuth()) },
    body: fd,
  });
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
    // Publication identity starts empty (the reader falls back to the From name).
    expect(body.settings.publication).toMatchObject({
      name: "",
      tagline: "",
      brandColor: "",
      logoUrl: "",
    });
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

describe("publication identity (issue #81)", () => {
  it("persists name + tagline and normalizes the brand color", async () => {
    const put = await putSettings({
      publication: { name: "  Field Notes  ", tagline: "Birding, weekly", brandColor: "#2563EB" },
    });
    expect(put.status).toBe(200);
    const { body } = await getSettings();
    expect(body.settings.publication.name).toBe("Field Notes");
    expect(body.settings.publication.tagline).toBe("Birding, weekly");
    expect(body.settings.publication.brandColor).toBe("#2563eb");
    // A readable text color is derived for filled brand controls.
    expect(body.settings.publication.brandTextColor).toBe("#ffffff");
  });

  it("expands a 3-digit hex and clears the color with an empty string", async () => {
    await putSettings({ publication: { brandColor: "#fff" } });
    expect((await getSettings()).body.settings.publication.brandColor).toBe("#ffffff");
    await putSettings({ publication: { brandColor: "" } });
    expect((await getSettings()).body.settings.publication.brandColor).toBe("");
  });

  it("rejects an invalid brand color with 400", async () => {
    const res = await putSettings({ publication: { brandColor: "cornflower" } });
    expect(res.status).toBe(400);
  });

  it("themes the public archive index with the name + tagline (a blank name falls back)", async () => {
    await putSettings({
      publication: { name: "The Hovering Hunter", tagline: "Notes from the field" },
    });
    const html = await (await SELF.fetch(`${BASE}/`)).text();
    expect(html).toContain("The Hovering Hunter");
    expect(html).toContain("Notes from the field");
  });
});

describe("email template (wired to the render path)", () => {
  const withUnsub = (extra = "") =>
    `<div>{{ post.body }}${extra}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

  it("returns a concrete default template even when none is stored", async () => {
    const { body } = await getSettings();
    expect(body.settings.emailTemplate).toContain("{{ post.body }}");
    expect(body.settings.emailTemplate).toContain("{{ email.unsubscribeUrl }}");
  });

  it("persists a valid template and reflects it back", async () => {
    const tpl = withUnsub(`<a href="{{ email.viewInBrowserUrl }}">View</a>`);
    const put = await putSettings({ emailTemplate: tpl });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { warnings: string[] }).warnings).toEqual([]);
    expect((await getSettings()).body.settings.emailTemplate).toBe(tpl);
  });

  it("rejects a template with no unsubscribe link (400) — every email must be leavable", async () => {
    const res = await putSettings({ emailTemplate: "<div>{{ post.body }}</div>" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message ?? "").toMatch(/unsubscribe/i);
  });

  it("rejects a template with no post body (400)", async () => {
    const res = await putSettings({
      emailTemplate: '<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a>',
    });
    expect(res.status).toBe(400);
  });

  it("warns (but allows) a missing view-in-browser link and unknown variables", async () => {
    const res = await putSettings({ emailTemplate: withUnsub("{{ made.up }}") });
    expect(res.status).toBe(200);
    const warnings = ((await res.json()) as { warnings: string[] }).warnings.join(" ");
    expect(warnings).toMatch(/view.?in.?browser/i);
    expect(warnings).toMatch(/made\.up/);
  });

  it('resets to the built-in default when set to ""', async () => {
    await putSettings({ emailTemplate: withUnsub() });
    const reset = await putSettings({ emailTemplate: "" });
    expect(reset.status).toBe(200);
    // The reflected template is the concrete default again (has a signed sign-off).
    expect((await getSettings()).body.settings.emailTemplate).toContain("Powered by Kestrel");
  });

  it("persists the publication mailing address for the compliance footer", async () => {
    await putSettings({ publication: { address: "123 Marsh Lane, Duluth, MN 55802" } });
    expect((await getSettings()).body.settings.publication.address).toBe(
      "123 Marsh Lane, Duluth, MN 55802",
    );
  });
});

describe("publication logo (issue #81)", () => {
  it("gates the logo routes like the rest of admin", async () => {
    const post = await SELF.fetch(`${BASE}/api/settings/logo`, { method: "POST" });
    expect(post.status).toBe(401);
    const del = await SELF.fetch(`${BASE}/api/settings/logo`, { method: "DELETE" });
    expect(del.status).toBe(401);
  });

  it("uploads a logo, reflects a cache-busted URL, serves it hardened, then removes it", async () => {
    const up = await putLogo(PNG_1x1, "image/png");
    expect(up.status).toBe(200);
    const { body } = await getSettings();
    expect(body.settings.publication.logoUrl).toContain("/media/branding/logo?v=");

    // Served publicly, and hardened so a hostile SVG can't run script on direct nav.
    const served = await SELF.fetch(`${BASE}/media/branding/logo`);
    expect(served.status).toBe(200);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");

    const del = await SELF.fetch(`${BASE}/api/settings/logo`, {
      method: "DELETE",
      headers: { ...(await adminAuth()) },
    });
    expect(del.status).toBe(200);
    expect((await getSettings()).body.settings.publication.logoUrl).toBe("");
    expect((await SELF.fetch(`${BASE}/media/branding/logo`)).status).toBe(404);
  });

  it("rejects a non-image upload with 400", async () => {
    const res = await putLogo(Uint8Array.from([1, 2, 3]), "application/pdf");
    expect(res.status).toBe(400);
  });
});
