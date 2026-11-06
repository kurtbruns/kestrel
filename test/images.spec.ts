import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { IMAGE_TYPE_BY_EXTENSION } from "../shared/images";
import type { AppEnv } from "../src/env";
import { FORMAT_NAMES, RASTER_IMAGE_TYPES } from "../src/lib/image_types";
import { AUTH, base, GIF_1x1, JPEG_1x1, PNG_1x1, readJson, WEBP_1x1 } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { fetchOn } from "./support/worker_env";

async function newDraft(title: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/api/posts`, {
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
  return SELF.fetch(`${base}/api/posts/${id}/images`, {
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
      return SELF.fetch(`${base}/api/posts/${id}/images`, {
        method: "POST",
        headers: AUTH,
        body: fd,
      });
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
    // A raw-body upload declares its type, so one the route doesn't take is refused as such.
    const raw = await SELF.fetch(`${base}/api/posts/${id}/images?filename=x.svg`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    expect(raw.status).toBe(415);
    const list = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
    );
    expect(list.images).toEqual([]);
  });

  it("reads a declared type by its media type, ignoring case and parameters", async () => {
    const id = await newDraft("Declared Types");
    const res = await SELF.fetch(`${base}/api/posts/${id}/images?filename=raw.png`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "Image/PNG; charset=binary" },
      body: PNG_1x1,
    });
    expect(res.status).toBe(201);
    expect((await readJson(res)).image.content_type).toBe("image/png");
  });

  describe("what an image is comes from its bytes (SPEC §4)", () => {
    const sendFile = (id: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return SELF.fetch(`${base}/api/posts/${id}/images`, {
        method: "POST",
        headers: AUTH,
        body: fd,
      });
    };

    it.each([
      ["image/png", PNG_1x1],
      ["image/jpeg", JPEG_1x1],
      ["image/webp", WEBP_1x1],
      ["image/gif", GIF_1x1],
    ] as const)(
      "stores %s with no extension and no declared type to go on",
      async (type, bytes) => {
        const id = await newDraft("Bytes");
        const res = await sendFile(
          id,
          new File([bytes], "upload", { type: "application/octet-stream" }),
        );
        expect(res.status).toBe(201);
        const { image } = await readJson(res);
        expect(image.content_type).toBe(type);
        const served = await SELF.fetch(`${base}/media/posts/${id}/${image.filename}`);
        expect(served.headers.get("content-type")).toBe(type);
      },
    );

    const JPEG_NAMED_PNG =
      "This file is a JPEG, but its name says PNG. Rename it to match, or convert it.";
    const JPEG_DECLARED_PNG =
      "This file is a JPEG, but its declared type says PNG, which a client may have read from the file's own name. Rename the file or send its real type, or convert it.";

    it.each([
      ["its name", "photo.png", "image/jpeg", JPEG_NAMED_PNG],
      ["its name, in capitals", "PHOTO.PNG", "application/octet-stream", JPEG_NAMED_PNG],
      ["its name and its type", "photo.png", "image/png", JPEG_NAMED_PNG],
      ["its type", "photo", "image/png", JPEG_DECLARED_PNG],
      ["its type, with case and parameters", "photo.jpg", "Image/PNG; x=y", JPEG_DECLARED_PNG],
    ])("refuses a JPEG labeled PNG by %s, and stores nothing", async (_what, name, type, said) => {
      const id = await newDraft("Mislabeled");
      const res = await sendFile(id, new File([JPEG_1x1], name, { type }));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ field: "file", message: said });
      const list = await readJson(
        await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
      );
      expect(list.images).toEqual([]);
    });

    it("holds a raw upload's name and declared type to its bytes too", async () => {
      const id = await newDraft("Mislabeled Raw");
      const raw = (filename: string, type: string) =>
        SELF.fetch(`${base}/api/posts/${id}/images?filename=${filename}`, {
          method: "POST",
          headers: { ...AUTH, "content-type": type },
          body: JPEG_1x1,
        });
      const named = await raw("photo.png", "image/jpeg");
      expect(named.status).toBe(400);
      expect((await readJson(named)).message).toBe(JPEG_NAMED_PNG);
      const declared = await raw("photo.jpg", "image/png");
      expect(declared.status).toBe(400);
      expect((await readJson(declared)).message).toBe(JPEG_DECLARED_PNG);
      const honest = await raw("photo.jpg", "image/jpeg");
      expect(honest.status).toBe(201);
    });

    describe("a form's filename, which replaces the file's own name", () => {
      const send = (file: File, filename: string, id: string) => {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("filename", filename);
        return SELF.fetch(`${base}/api/posts/${id}/images`, {
          method: "POST",
          headers: AUTH,
          body: fd,
        });
      };

      it("is held to the bytes", async () => {
        const id = await newDraft("Named");
        const file = new File([JPEG_1x1], "photo.jpg", { type: "image/jpeg" });
        expect((await send(file, "hero.jpg", id)).status).toBe(201);
        const refused = await send(file, "hero.png", id);
        expect(refused.status).toBe(400);
        expect((await readJson(refused)).message).toBe(JPEG_NAMED_PNG);
      });

      it("excuses the file's own name when the client states the real type", async () => {
        // curl can: -F "file=@photo.png;type=image/jpeg" -F filename=hero.jpg
        const id = await newDraft("Named");
        const file = new File([JPEG_1x1], "photo.png", { type: "image/jpeg" });
        expect((await send(file, "hero.jpg", id)).status).toBe(201);
      });

      it("tells a client that read the type from a misnamed file to rename it", async () => {
        // The CLI and a browser type a part from its file's name, so --form file=@photo.png
        // --form filename=photo.jpg declares a PNG, and they have no flag to say otherwise.
        const id = await newDraft("Named");
        const file = new File([JPEG_1x1], "photo.png", { type: "image/png" });
        const refused = await send(file, "photo.jpg", id);
        expect(refused.status).toBe(400);
        expect((await readJson(refused)).message).toBe(JPEG_DECLARED_PNG);
      });
    });

    it("refuses a raw upload that declares no type, whatever its bytes", async () => {
      const id = await newDraft("Typeless");
      const res = await SELF.fetch(`${base}/api/posts/${id}/images?filename=cover.png`, {
        method: "POST",
        headers: AUTH,
        body: PNG_1x1,
      });
      expect(res.status).toBe(400);
      expect((await readJson(res)).message).toBe("An image must be a PNG, JPEG, WebP, or GIF.");
      const list = await readJson(
        await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
      );
      expect(list.images).toEqual([]);
    });

    it("takes both versions of the GIF signature, and no other", async () => {
      const id = await newDraft("Gifs");
      const gif = (version: string) =>
        new File([new TextEncoder().encode(`${version}\x01\0\x01\0\0\0\0;`)], "anim", {
          type: "application/octet-stream",
        });
      const old = await sendFile(id, gif("GIF87a"));
      expect(old.status).toBe(201);
      expect((await readJson(old)).image.content_type).toBe("image/gif");
      expect((await sendFile(id, gif("GIF88a"))).status).toBe(400);
    });

    it("has a name for every format an extension or a type can claim", () => {
      const claimed = [...new Set(Object.values(IMAGE_TYPE_BY_EXTENSION))].sort();
      expect(claimed).toEqual([...RASTER_IMAGE_TYPES].sort());
      expect(Object.keys(FORMAT_NAMES).sort()).toEqual(claimed);
    });

    it.each([
      ["an extension outside the formats", "cover.tiff", "image/tiff"],
      ["a dot in a screenshot's time", "Screenshot 9.41.00", "application/octet-stream"],
      ["no extension", "cover", ""],
    ])("takes a PNG with %s, which claims nothing", async (_what, name, type) => {
      const id = await newDraft("No Claim");
      const res = await sendFile(id, new File([PNG_1x1], name, { type }));
      expect(res.status).toBe(201);
      expect((await readJson(res)).image.content_type).toBe("image/png");
    });

    it.each([
      ["cover.JPG", JPEG_1x1, "image/jpeg"],
      ["cover.jpeg", JPEG_1x1, "image/jpeg"],
      ["cover.webp", WEBP_1x1, "image/webp"],
      ["cover.gif", GIF_1x1, "image/gif"],
    ])("takes %s when its name and its bytes agree", async (name, bytes, type) => {
      const id = await newDraft("Agreeing");
      const res = await sendFile(id, new File([bytes], name, { type }));
      expect(res.status).toBe(201);
      expect((await readJson(res)).image.content_type).toBe(type);
    });

    it.each([
      ["text", new TextEncoder().encode("not an image at all")],
      ["an SVG", new TextEncoder().encode("<svg onload=alert(1)>")],
      ["a RIFF file that isn't WebP", new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")],
      ["a cut-off PNG signature", PNG_1x1.slice(0, 4)],
    ])("refuses %s under an image's name and type, and stores nothing", async (_what, bytes) => {
      const id = await newDraft("Not An Image");
      const form = await sendFile(id, new File([bytes], "cover.png", { type: "image/png" }));
      expect(form.status).toBe(400);
      expect(await readJson(form)).toMatchObject({
        field: "file",
        message: "An image must be a PNG, JPEG, WebP, or GIF.",
      });
      const raw = await SELF.fetch(`${base}/api/posts/${id}/images?filename=cover.png`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "image/png" },
        body: bytes,
      });
      expect(raw.status).toBe(400);
      expect((await readJson(raw)).message).toBe("An image must be a PNG, JPEG, WebP, or GIF.");
      const list = await readJson(
        await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
      );
      expect(list.images).toEqual([]);
    });

    it("calls an empty file empty, whatever it claims to be", async () => {
      const id = await newDraft("Empty");
      const res = await sendFile(id, new File([], "cover.png", { type: "image/png" }));
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({
        field: "file",
        message: "The image file is empty.",
      });
    });
  });

  it("lists images and deletes one", async () => {
    const id = await newDraft("Gallery");
    // Two, so the delete is shown to take the one named and leave its sibling.
    expect((await upload(id, "a.png", AUTH)).status).toBe(201);
    expect((await upload(id, "b.png", AUTH)).status).toBe(201);
    const listed = async () =>
      (await readJson(await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }))).images
        .map((i: any) => i.filename)
        .sort();

    expect(await listed()).toEqual(["a.png", "b.png"]);

    const del = await SELF.fetch(`${base}/api/posts/${id}/images/a.png`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);

    // Gone from the list, the table, and the bucket; the sibling untouched in all three.
    expect(await listed()).toEqual(["b.png"]);
    const rows = await env.DB.prepare("SELECT filename FROM images WHERE post_id = ?")
      .bind(id)
      .all<{ filename: string }>();
    expect(rows.results.map((r) => r.filename)).toEqual(["b.png"]);
    expect((await SELF.fetch(`${base}/media/posts/${id}/a.png`)).status).toBe(404);
    expect((await SELF.fetch(`${base}/media/posts/${id}/b.png`)).status).toBe(200);
  });

  it("stores an upload under a name a reference can use, keeping its case (SPEC §4)", async () => {
    const id = await newDraft("Names");
    for (const [sent, stored] of [
      // A macOS screenshot: spaces, and a narrow no-break space before "AM".
      ["Screenshot 2026-10-30 at 9.41.12 AM.png", "Screenshot-2026-10-30-at-9.41.12-AM.png"],
      ["My Cover (2).PNG", "My-Cover-2.PNG"],
      ["tab\tand nbsp.png", "tab-and-nbsp.png"],
      ["<a>[b]`c`.png", "a-b-c.png"],
      ["50% #1?.png", "50-1.png"],
      ["clean_name-1.png", "clean_name-1.png"],
      ["café.png", "café.png"],
    ] as const) {
      const res = await upload(id, sent, AUTH);
      expect(res.status, sent).toBe(201);
      const { image } = await readJson(res);
      expect(image.filename, sent).toBe(stored);
      expect(new URL(image.url).pathname).toBe(`/media/posts/${id}/${encodeURI(stored)}`);
    }
  });

  it("cleans a raw upload's name and a form's named one as it does the file's own (SPEC §4)", async () => {
    const id = await newDraft("Other Names");
    const raw = await SELF.fetch(
      `${base}/api/posts/${id}/images?filename=${encodeURIComponent("raw shot.png")}`,
      { method: "POST", headers: { ...AUTH, "content-type": "image/png" }, body: PNG_1x1 },
    );
    expect((await readJson(raw)).image.filename).toBe("raw-shot.png");

    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "ignored.png", { type: "image/png" }));
    fd.append("filename", "dir/named shot.png");
    const named = await SELF.fetch(`${base}/api/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect((await readJson(named)).image.filename).toBe("named-shot.png");
  });

  it("refuses a name with nothing in it but what cleaning removes, in the same words however it came", async () => {
    const id = await newDraft("Blank Name");
    const raw = await SELF.fetch(`${base}/api/posts/${id}/images?filename=%20%20`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "image/png" },
      body: PNG_1x1,
    });
    expect(raw.status).toBe(400);
    expect(await readJson(raw)).toMatchObject({
      field: "filename",
      message: "a filename is required",
    });
  });

  it("a reference by the name an upload answered becomes an image in the preview, and the stored bytes serve at its address (SPEC §4)", async () => {
    const id = await newDraft("Screenshot");
    const { image } = await readJson(await upload(id, "Shot 9.41 AM.png", AUTH));
    const { post } = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    const saved = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        markdown: `![A screenshot](${image.filename})`,
        base_revision: post.current_revision,
      }),
    });
    expect(saved.status).toBe(200);
    const preview = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/preview.json`, { headers: AUTH }),
    );
    expect(preview.warnings).toEqual([]);
    expect((await SELF.fetch(`${base}/media/posts/${id}/${image.filename}`)).status).toBe(200);
  });

  it("deletes an image stored before names were cleaned, by the name it kept (SPEC §4)", async () => {
    const id = await newDraft("Old Name");
    const key = `posts/${id}/old shot.png`;
    await env.MEDIA.put(key, PNG_1x1, { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare(
      "INSERT INTO images (id, post_id, filename, storage_key, content_type, created_at) VALUES ('i1', ?, 'old shot.png', ?, 'image/png', 0)",
    )
      .bind(id, key)
      .run();
    const listed = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
    );
    expect(listed.images.map((i: any) => i.filename)).toEqual(["old shot.png"]);

    const del = await SELF.fetch(
      `${base}/api/posts/${id}/images/${encodeURIComponent("old shot.png")}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(del.status).toBe(200);
    expect(await env.MEDIA.get(key)).toBeNull();
  });

  it("deletes an upload by the name it answered, which is not the name sent (SPEC §4)", async () => {
    const id = await newDraft("New Name");
    const { image } = await readJson(await upload(id, "new shot.png", AUTH));
    const del = await SELF.fetch(`${base}/api/posts/${id}/images/${image.filename}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);
    expect((await SELF.fetch(`${base}/media/posts/${id}/${image.filename}`)).status).toBe(404);
  });

  describe("a name the post already has (SPEC §4)", () => {
    const sendBytes = async (id: string, name: string, size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(PNG_1x1);
      const fd = new FormData();
      fd.append("file", new File([bytes], name, { type: "image/png" }));
      const res = await SELF.fetch(`${base}/api/posts/${id}/images`, {
        method: "POST",
        headers: AUTH,
        body: fd,
      });
      expect(res.status).toBe(201);
      return (await readJson(res)).image.filename as string;
    };
    const servedSize = async (id: string, name: string) =>
      (await (await SELF.fetch(`${base}/media/posts/${id}/${name}`)).arrayBuffer()).byteLength;

    it("gets a number, and the image it would have replaced keeps its bytes", async () => {
      const id = await newDraft("Pasted Twice");
      const size = PNG_1x1.length;
      expect(await sendBytes(id, "image.png", size + 1)).toBe("image.png");
      expect(await sendBytes(id, "image.png", size + 2)).toBe("image-2.png");
      expect(await sendBytes(id, "image.png", size + 3)).toBe("image-3.png");
      expect(await servedSize(id, "image.png")).toBe(size + 1);
      expect(await servedSize(id, "image-2.png")).toBe(size + 2);
      expect(await servedSize(id, "image-3.png")).toBe(size + 3);
    });

    it("gets a number after cleaning, and on a name with no extension", async () => {
      const id = await newDraft("Same Once Clean");
      expect(await sendBytes(id, "my shot.png", PNG_1x1.length)).toBe("my-shot.png");
      expect(await sendBytes(id, "my-shot.png", PNG_1x1.length)).toBe("my-shot-2.png");
      expect(await sendBytes(id, "chart", PNG_1x1.length)).toBe("chart");
      expect(await sendBytes(id, "chart", PNG_1x1.length)).toBe("chart-2");
    });

    it("gives uploads sent at once a name each, with their own bytes", async () => {
      const id = await newDraft("Dropped Together");
      const sizes = [1, 2, 3, 4, 5].map((extra) => PNG_1x1.length + extra);
      const names = await Promise.all(sizes.map((size) => sendBytes(id, "image.png", size)));
      expect([...names].sort()).toEqual([
        "image-2.png",
        "image-3.png",
        "image-4.png",
        "image-5.png",
        "image.png",
      ]);
      for (const [i, name] of names.entries()) {
        expect(await servedSize(id, name)).toBe(sizes[i]);
      }
    });

    it("isn't taken from another post, whose images have names of their own", async () => {
      const [one, two] = [await newDraft("One"), await newDraft("Two")];
      expect(await sendBytes(one, "image.png", PNG_1x1.length)).toBe("image.png");
      expect(await sendBytes(two, "image.png", PNG_1x1.length)).toBe("image.png");
    });

    it("is free again once the image holding it is deleted", async () => {
      const id = await newDraft("Freed");
      await sendBytes(id, "image.png", PNG_1x1.length);
      await SELF.fetch(`${base}/api/posts/${id}/images/image.png`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(await sendBytes(id, "image.png", PNG_1x1.length)).toBe("image.png");
    });
  });

  it("gives back the name it claimed when storing the bytes fails", async () => {
    allowErrorLogs("request.error");
    const id = await newDraft("Storage Down");
    const failing = {
      ...env,
      MEDIA: {
        put: () => Promise.reject(new Error("R2 is down")),
      },
    } as unknown as AppEnv;
    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "image.png", { type: "image/png" }));
    const res = await fetchOn(failing, `/api/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(res.status).toBe(500);
    const list = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/images`, { headers: AUTH }),
    );
    expect(list.images).toEqual([]);
  });

  it("rejects upload on a non-draft post (409)", async () => {
    const id = await newDraft("Locked Images");
    await env.DB.prepare("UPDATE posts SET status = 'scheduled' WHERE id = ?").bind(id).run();
    const up = await upload(id, "x.png", AUTH);
    expect(up.status).toBe(409);
    expect(await readJson(up)).toMatchObject({
      error: "post_not_draft",
      message: "This post is scheduled, so it’s locked. Cancel the schedule to edit it.",
      post: { id, status: "scheduled" },
    });
  });

  it("requires auth to upload", async () => {
    const id = await newDraft("Auth Images");
    const up = await upload(id, "x.png"); // no auth header
    expect(up.status).toBe(401);
  });
});
