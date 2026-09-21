import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
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

  it("a scheduled post's test and preview are its frozen copy, not a live render (SPEC §5)", async () => {
    // Once the re-make rule holds, the frozen copy differs from a live render only by
    // a direct edit of the send's bytes, which is exactly what makes this test honest:
    // the instruments must read the send, whatever it holds.
    const id = await draftWithImage("Frozen");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 600_000).toISOString() }),
      }),
    );
    const sentinel = `FROZEN-${crypto.randomUUID()}`;
    await env.DB.prepare("UPDATE sends SET rendered_html = ?, rendered_text = ? WHERE id = ?")
      .bind(
        `<p>${sentinel}</p><a href="%%UNSUBSCRIBE_URL%%">u</a>`,
        `${sentinel}\nUnsubscribe: %%UNSUBSCRIBE_URL%%`,
        scheduled.send.id,
      )
      .run();

    const to = `frozen-${id}@example.com`;
    const test = await readJson(
      await SELF.fetch(`${base}/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to }),
      }),
    );
    expect(test.frozen).toBe(true);
    const msg = (
      await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }))
    ).messages.find((m: any) => m.to === to);
    expect(msg.html).toContain(sentinel);
    expect(msg.html).toContain("/unsubscribe?test=1"); // the placeholders are filled as at fire
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");

    const page = await (await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH })).text();
    expect(page).toContain(sentinel);
    expect(page).toContain("/unsubscribe");
    expect(page).not.toContain("%%UNSUBSCRIBE_URL%%");
    const action = await readJson(
      await SELF.fetch(`${base}/posts/${id}/preview`, { method: "POST", headers: AUTH }),
    );
    expect(action.frozen).toBe(true);

    // A post whose send is in flight is still the frozen copy (the post stays
    // `scheduled` while its send is `sending`).
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(Date.now(), scheduled.send.id)
      .run();
    const inFlight = await (
      await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(inFlight).toContain(sentinel);

    // Once sent, the record's copy: the same bytes the archive page serves (I3).
    await env.DB.batch([
      env.DB.prepare("UPDATE sends SET status = 'sent', completed_at = ? WHERE id = ?").bind(
        Date.now(),
        scheduled.send.id,
      ),
      env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(id),
    ]);
    const sentPage = await (
      await SELF.fetch(`${base}/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(sentPage).toContain(sentinel);
    const sentTest = await readJson(
      await SELF.fetch(`${base}/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to: `sent-${to}` }),
      }),
    );
    expect(sentTest.frozen).toBe(true);
    const post = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
    const slug = post.post.slug;
    const archive = await (await SELF.fetch(`${base}/archive/${slug}`)).text();
    expect(archive).toContain(sentinel);
  });

  it("a draft's test and preview are a live render (frozen: false)", async () => {
    const id = await draftWithImage("Live");
    const action = await readJson(
      await SELF.fetch(`${base}/posts/${id}/preview`, { method: "POST", headers: AUTH }),
    );
    expect(action.frozen).toBe(false);
    const test = await readJson(
      await SELF.fetch(`${base}/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to: `live-${id}@example.com` }),
      }),
    );
    expect(test.frozen).toBe(false);
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
