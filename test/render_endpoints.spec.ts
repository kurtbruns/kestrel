import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const AUTH = { Authorization: "Bearer test-bearer-token" };
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
      body: JSON.stringify({ title, subject: `Subject: ${title}`, markdown: "# Hi\n\n![A cat](cat.png)" }),
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
