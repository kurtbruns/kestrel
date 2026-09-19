import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);

async function draftWithImage(title: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: `Subject: ${title}`, markdown: "# Hi\n\n![A cat](cat.png)" }),
    }),
  );
  const id = created.post.id;
  const fd = new FormData();
  fd.append("file", new File([PNG_1x1], "cat.png", { type: "image/png" }));
  await SELF.fetch(`${base}/posts/${id}/images`, { method: "POST", headers: AUTH, body: fd });
  return id;
}

describe("preview + test endpoints", () => {
  it("POST /preview returns a hosted view-in-browser URL", async () => {
    const id = await draftWithImage("Preview One");
    const res = await SELF.fetch(`${base}/posts/${id}/preview`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.url).toBe(`http://localhost:8787/posts/${id}/preview`);
    expect(body.subject).toBe("Subject: Preview One");
  });

  it("GET /preview serves rendered HTML with the sentinel substituted", async () => {
    const id = await draftWithImage("Preview Two");
    const res = await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`/media/posts/${id}/cat.png`);
    expect(html).not.toContain("%%UNSUBSCRIBE_URL%%");
    expect(html).toContain("/unsubscribe");
  });

  it("GET /preview requires auth", async () => {
    const id = await draftWithImage("Preview Auth");
    const res = await SELF.fetch(`${base}/posts/${id}/preview`);
    expect(res.status).toBe(401);
  });

  it("POST /test sends the real render through the provider (same render path, I5)", async () => {
    const id = await draftWithImage("Test Send");
    const to = `probe-${id}@example.com`;
    const res = await SELF.fetch(`${base}/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(true);
    expect(body.provider).toBe("fake");

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const msg = outbox.messages.find((m: any) => m.to === to);
    expect(msg).toBeTruthy();
    expect(msg.subject).toBe("Subject: Test Send");
    // Same render path as preview: resolved image URL present, sentinel substituted.
    expect(msg.html).toContain(`/media/posts/${id}/cat.png`);
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");
    expect(msg.html).toContain("/unsubscribe?test=1");
  });

  // A scheduled post's instruments show the frozen copy (SPEC §5): once scheduled, a
  // template change made afterwards reaches neither the test nor the preview page, so
  // the two never disagree about what is going out. A draft stays live.
  const tpl = (marker: string) =>
    `<div class="${marker}">{{ post.body }}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;
  async function putTemplate(html: string) {
    const res = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ emailTemplate: html }),
    });
    expect(res.status).toBe(200);
  }
  async function outboxFor(to: string) {
    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    return outbox.messages.find((m: any) => m.to === to);
  }

  it("POST /test on a scheduled post sends the frozen copy, even after the template changes", async () => {
    await putTemplate(tpl("frozen-look"));
    const id = await draftWithImage("Frozen Test");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
      }),
    );
    expect(scheduled.send.rendered_html).toContain('class="frozen-look"');
    // The template (and the identity) change after scheduling.
    await putTemplate(tpl("monday-look"));

    const to = `frozen-${id}@example.com`;
    const res = await SELF.fetch(`${base}/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(true);
    expect(body.frozen).toBe(true);
    expect(body.send_id).toBe(scheduled.send.id);

    const msg = await outboxFor(to);
    expect(msg).toBeTruthy();
    // The send's frozen bytes, with the per-recipient placeholders filled exactly as the
    // fire path fills them — never a live render of the current template.
    expect(msg.html).toContain('class="frozen-look"');
    expect(msg.html).not.toContain('class="monday-look"');
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");
    expect(msg.html).toContain("/unsubscribe?test=1");
    expect(msg.html).toContain(`/media/posts/${id}/cat.png`);

    // The preview page agrees with the test: the same frozen copy.
    const page = await (await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH })).text();
    expect(page).toContain('class="frozen-look"');
    expect(page).not.toContain('class="monday-look"');
    const info = await readJson(
      await SELF.fetch(`${base}/posts/${id}/preview`, { method: "POST", headers: AUTH }),
    );
    expect(info.frozen).toBe(true);
  });

  it("POST /test on a draft sends the live render: the current template", async () => {
    await putTemplate(tpl("live-look"));
    const id = await draftWithImage("Live Test");
    await putTemplate(tpl("newer-look"));

    const to = `live-${id}@example.com`;
    const body = await readJson(
      await SELF.fetch(`${base}/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to }),
      }),
    );
    expect(body.frozen).toBe(false);
    expect(body.send_id).toBeNull();
    const msg = await outboxFor(to);
    expect(msg.html).toContain('class="newer-look"');
    expect(msg.html).not.toContain('class="live-look"');
    const page = await (await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH })).text();
    expect(page).toContain('class="newer-look"');
  });

  it("POST /test rejects a missing/invalid address (400)", async () => {
    const id = await draftWithImage("Bad Address");
    const res = await SELF.fetch(`${base}/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("template test-send (POST /api/settings/template/test)", () => {
  it("requires auth", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "you@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("renders a sample post through the one render path and delivers it (I5)", async () => {
    const to = "template-probe@example.com";
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(1);
    expect(body.total).toBe(1);
    expect(body.provider).toBe("fake");

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const msg = outbox.messages.find((m: any) => m.to === to);
    expect(msg).toBeTruthy();
    // The sample body flows through the same render as a real send: sentinel
    // substituted, the test unsubscribe link present.
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");
    expect(msg.html).toContain("/unsubscribe?test=1");
    // The sample subject line proves it rendered the synthetic post.
    expect(msg.subject).toContain("Template test");
  });

  it("accepts several addresses in one call", async () => {
    const tos = ["multi-a@example.com", "multi-b@example.com"];
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: tos }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(2);
    expect(body.total).toBe(2);
  });

  it("falls back to the saved default recipients when `to` is omitted", async () => {
    const dflt = "default-inbox@example.com";
    const put = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ testRecipients: [dflt] }),
    });
    expect(put.status).toBe(200);

    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.recipients).toEqual([dflt]);
    expect(body.sent).toBe(1);
  });

  it("400s when there are no recipients and no defaults", async () => {
    // Clear any default recipients a prior test set.
    await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ testRecipients: [] }),
    });
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid address", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});
