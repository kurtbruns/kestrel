import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRMATION_EMAIL } from "../src/db/settings";
import { confirmationEmail } from "../src/emails/system";
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
          address: string;
          logoUrl: string;
        };
        emailTemplate: string;
        confirmationEmail: {
          subject: string;
          body: string;
          buttonLabel: string;
          reassurance: string;
        };
        confirmationEmailDefault: {
          subject: string;
          body: string;
          buttonLabel: string;
          reassurance: string;
        };
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

/** Subscribe a fresh address (public double opt-in) and return the confirmation email
 *  the fake transport recorded for it. */
async function subscribeAndGetConfirmation() {
  const email = `ce-${crypto.randomUUID()}@example.com`;
  const sub = await SELF.fetch(`${BASE}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(sub.ok).toBe(true);
  const outbox = (await (
    await SELF.fetch(`${BASE}/api/dev/outbox`, { headers: await adminAuth() })
  ).json()) as { messages: { to: string; subject: string; html: string; text: string }[] };
  return outbox.messages.find((m) => m.to === email);
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
  it("persists and normalizes name + tagline", async () => {
    const put = await putSettings({
      publication: { name: "  Field Notes  ", tagline: "Birding, weekly" },
    });
    expect(put.status).toBe(200);
    const { body } = await getSettings();
    expect(body.settings.publication.name).toBe("Field Notes");
    expect(body.settings.publication.tagline).toBe("Birding, weekly");
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

  it("rejects an empty template (400) instead of silently resetting to the default", async () => {
    await putSettings({ emailTemplate: withUnsub() });
    const res = await putSettings({ emailTemplate: "" });
    expect(res.status).toBe(400);
    // The previously saved template is untouched — no silent reset to the default.
    const stored = (await getSettings()).body.settings.emailTemplate;
    expect(stored).toContain("{{ email.unsubscribeUrl }}");
    expect(stored).not.toContain("Powered by Kestrel");
  });

  it("persists the publication mailing address for the compliance footer", async () => {
    await putSettings({ publication: { address: "123 Marsh Lane, Duluth, MN 55802" } });
    expect((await getSettings()).body.settings.publication.address).toBe(
      "123 Marsh Lane, Duluth, MN 55802",
    );
  });
});

describe("confirmation email copy (SPEC §7)", () => {
  it("returns the built-in default copy (effective + a default sibling) when none is stored", async () => {
    const { body } = await getSettings();
    const ce = body.settings.confirmationEmail;
    expect(ce.subject).toBe("Confirm your subscription");
    expect(ce.buttonLabel).toBe("Confirm subscription");
    expect(ce.body).toMatch(/confirm your email/i);
    // The default sibling lets a client offer "Reset to default" without hardcoding copy.
    expect(body.settings.confirmationEmailDefault).toEqual(ce);
  });

  it("persists edited copy (trimmed) and reflects it back", async () => {
    const put = await putSettings({
      confirmationEmail: {
        subject: "  Confirm your Windbreak subscription  ",
        body: "One tap and you're in.",
        buttonLabel: "Yes, confirm",
        reassurance: "",
      },
    });
    expect(put.status).toBe(200);
    const ce = (await getSettings()).body.settings.confirmationEmail;
    expect(ce.subject).toBe("Confirm your Windbreak subscription");
    expect(ce.body).toBe("One tap and you're in.");
    expect(ce.buttonLabel).toBe("Yes, confirm");
    // A blank reassurance line is allowed (it simply drops the footer).
    expect(ce.reassurance).toBe("");
  });

  it("resolves a blank required field back to the built-in default (never wordless)", async () => {
    await putSettings({ confirmationEmail: { subject: "Keep me", body: "Body here" } });
    await putSettings({ confirmationEmail: { subject: "", body: "", buttonLabel: "" } });
    const ce = (await getSettings()).body.settings.confirmationEmail;
    expect(ce.subject).toBe("Confirm your subscription");
    expect(ce.buttonLabel).toBe("Confirm subscription");
    expect(ce.body).toMatch(/confirm your email/i);
  });

  it("rejects a non-string field with 400", async () => {
    const res = await putSettings({ confirmationEmail: { subject: 42 } });
    expect(res.status).toBe(400);
  });

  it("the sent confirmation email reflects the edited copy (subject + body + button)", async () => {
    await putSettings({
      confirmationEmail: {
        subject: "Please confirm — Marsh Notes",
        body: "Tap below to start receiving Marsh Notes.",
        buttonLabel: "Confirm my email",
        reassurance: "Not you? Ignore this.",
      },
    });
    const msg = await subscribeAndGetConfirmation();
    expect(msg?.subject).toBe("Please confirm — Marsh Notes");
    expect(msg?.html).toContain("Tap below to start receiving Marsh Notes.");
    expect(msg?.html).toContain("Confirm my email");
    expect(msg?.html).toContain("Not you? Ignore this.");
    expect(msg?.text).toContain("Tap below to start receiving Marsh Notes.");
  });

  it("the sent confirmation email is headed with the publication identity", async () => {
    // A distinctive name that appears only in the masthead — never in the subject/body.
    await putSettings({
      publication: { name: "Heron Digest", tagline: "Wetland field notes" },
      confirmationEmail: {
        subject: "Confirm please",
        body: "Tap to finish signing up.",
        buttonLabel: "Confirm",
        reassurance: "",
      },
    });
    const msg = await subscribeAndGetConfirmation();
    expect(msg?.html).toContain("Heron Digest");
    expect(msg?.html).toContain("Wetland field notes");
  });
});

// The masthead renders directly (a pure function of copy + identity), so its
// degrade-to-plain behavior is unit-tested without the subscribe round-trip.
describe("confirmation email masthead (SPEC §7)", () => {
  const link = "https://kestrel.test/confirm?token=abc123";

  it("degrades to no masthead when there is no identity, keeping the confirm link", () => {
    const r = confirmationEmail(link, DEFAULT_CONFIRMATION_EMAIL, {
      name: "",
      tagline: "",
      logoUrl: "",
    });
    expect(r.html).not.toContain("<hr");
    expect(r.html).toContain("Confirm subscription");
    expect(r.html).toContain(link);
  });

  it("renders the masthead (name + tagline + rule) when an identity is present", () => {
    const r = confirmationEmail(link, DEFAULT_CONFIRMATION_EMAIL, {
      name: "Heron Digest",
      tagline: "Wetland field notes",
      logoUrl: "",
    });
    expect(r.html).toContain("<hr");
    expect(r.html).toContain("Heron Digest");
    expect(r.html).toContain("Wetland field notes");
  });

  it("escapes operator copy and identity into the HTML (no injection)", () => {
    const r = confirmationEmail(
      link,
      {
        subject: "Confirm",
        body: "<script>alert(1)</script>",
        buttonLabel: "Go",
        reassurance: "a <b> c",
      },
      { name: '"><img src=x onerror=alert(1)>', tagline: "notes & more", logoUrl: "" },
    );
    // Operator copy is escaped as text, not injected as markup.
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).not.toContain("a <b> c");
    // The identity name can't break out of the masthead's alt attribute or its <div>.
    expect(r.html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(r.html).toContain("notes &amp; more");
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
