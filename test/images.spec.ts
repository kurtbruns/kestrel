import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

// A real 1x1 PNG so the dimension probe has something to read.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);

async function newDraft(title: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ subject: title }),
    }),
  );
  return created.post.id;
}

function upload(id: string, name: string, extraHeaders: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([PNG_1x1], name, { type: "image/png" }));
  return SELF.fetch(`${base}/posts/${id}/images`, {
    method: "POST",
    headers: { ...extraHeaders },
    body: fd,
  });
}

describe("images", () => {
  it("uploads (multipart), records dimensions, and serves the bytes publicly", async () => {
    const id = await newDraft("With Image");
    const up = await upload(id, "cover.png", AUTH);
    expect(up.status).toBe(201);
    const { image } = await readJson(up);
    expect(image.filename).toBe("cover.png");
    expect(image.content_type).toBe("image/png");
    expect(image.width).toBe(1);
    expect(image.height).toBe(1);
    expect(image.url).toContain(`/media/posts/${id}/cover.png`);

    // public serving (no auth)
    const served = await SELF.fetch(`${base}/media/posts/${id}/cover.png`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(bytes.length).toBe(PNG_1x1.length);
  });

  it("refuses an upload that is not a raster image, or is too large", async () => {
    const id = await newDraft("Refusals");
    const send = (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return SELF.fetch(`${base}/posts/${id}/images`, { method: "POST", headers: AUTH, body: fd });
    };
    // An SVG or HTML file would run as a page on a public media domain.
    for (const [name, type] of [
      ["x.svg", "image/svg+xml"],
      ["x.html", "text/html"],
      ["x.bin", "application/octet-stream"],
    ] as const) {
      const res = await send(new File(["<svg onload=alert(1)>"], name, { type }));
      expect(res.status, type).toBe(400);
      expect((await readJson(res)).message).toMatch(/PNG, JPEG, WebP, or GIF/);
    }
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG_1x1);
    const tooBig = await send(new File([big], "huge.png", { type: "image/png" }));
    expect(tooBig.status).toBe(400);
    expect((await readJson(tooBig)).message).toMatch(/5 MB or smaller/);
    // A raw-body upload is held to the same rule.
    const raw = await SELF.fetch(`${base}/posts/${id}/images?filename=x.svg`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    expect(raw.status).toBe(400);
    const list = await readJson(await SELF.fetch(`${base}/posts/${id}/images`, { headers: AUTH }));
    expect(list.images).toEqual([]);
  });

  it("lists images and deletes one", async () => {
    const id = await newDraft("Gallery");
    await upload(id, "a.png", AUTH);

    const list = await readJson(await SELF.fetch(`${base}/posts/${id}/images`, { headers: AUTH }));
    expect(list.images.map((i: any) => i.filename)).toContain("a.png");

    const del = await SELF.fetch(`${base}/posts/${id}/images/a.png`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);

    const served = await SELF.fetch(`${base}/media/posts/${id}/a.png`);
    expect(served.status).toBe(404);
  });

  it("rejects upload on a non-draft post (409)", async () => {
    const id = await newDraft("Locked Images");
    await env.DB.prepare("UPDATE posts SET status = 'scheduled' WHERE id = ?").bind(id).run();
    const up = await upload(id, "x.png", AUTH);
    expect(up.status).toBe(409);
  });

  it("requires auth to upload", async () => {
    const id = await newDraft("Auth Images");
    const up = await upload(id, "x.png"); // no auth header
    expect(up.status).toBe(401);
  });
});
