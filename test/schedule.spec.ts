import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SEND_NOW_BUFFER_MS } from "../src/lib/time";

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

async function makeDraft(markdown = "# Hi\n\nbody"): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: "The Subject", markdown }),
    }),
  );
  return created.post.id;
}

function future(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function postStatus(id: string): Promise<string> {
  const body = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
  return body.post.status;
}

describe("schedule / send / cancel + soft-lock", () => {
  it("schedules a future send, freezes the render, and locks the post (I3, I6)", async () => {
    const id = await makeDraft();
    const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.status).toBe("scheduled");
    expect(send.rendered_html).toContain("The Subject");
    expect(await postStatus(id)).toBe("scheduled");
  });

  it("soft-locks edits and image changes while scheduled (409)", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });

    const put = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "changed" }),
    });
    expect(put.status).toBe(409);

    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "x.png", { type: "image/png" }));
    const img = await SELF.fetch(`${base}/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(img.status).toBe(409);

    // second schedule while active → 409
    const again = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });
    expect(again.status).toBe(409);
  });

  it("rejects fire_at that isn't at least the buffer in the future (400)", async () => {
    const id = await makeDraft();
    for (const fire_at of [future(-1000), future(60 * 1000)]) {
      const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("cancel unlocks the post; the frozen render is unchanged by later edits (I3)", async () => {
    const id = await makeDraft("original body");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const sendId = scheduled.send.id;
    const frozenHtml = scheduled.send.rendered_html;

    const cancel = await SELF.fetch(`${base}/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(cancel.status).toBe(200);
    expect(await postStatus(id)).toBe("draft");

    // edit is allowed again
    const put = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "totally different body" }),
    });
    expect(put.status).toBe(200);

    // the canceled send's frozen bytes did not change
    const still = await readJson(await SELF.fetch(`${base}/sends/${sendId}`, { headers: AUTH }));
    expect(still.send.rendered_html).toBe(frozenHtml);
    expect(still.send.rendered_html).toContain("original body");

    // cancel again → 409
    const twice = await SELF.fetch(`${base}/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(twice.status).toBe(409);
  });

  it("snapshots recipient_count at schedule time", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?)",
      )
        .bind(`sub-${i}`, `c${i}@example.com`, `tok-${i}`, now, now)
        .run();
    }
    const id = await makeDraft();
    const { send } = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    expect(send.recipient_count).toBe(3);
  });

  it("send-now schedules at now + buffer and is idempotent", async () => {
    const id = await makeDraft();
    const first = await readJson(
      await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(first.send.status).toBe("scheduled");
    expect(
      Math.abs(first.send.fire_at - first.send.scheduled_at - SEND_NOW_BUFFER_MS),
    ).toBeLessThan(2000);

    const second = await readJson(
      await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(second.idempotent).toBe(true);
    expect(second.send.id).toBe(first.send.id);
  });

  it("lists sends and requires auth", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    const list = await readJson(await SELF.fetch(`${base}/sends`, { headers: AUTH }));
    expect(list.sends.length).toBeGreaterThanOrEqual(1);
    expect(list.sends[0]).toHaveProperty("progress");

    const noauth = await SELF.fetch(`${base}/sends`);
    expect(noauth.status).toBe(401);
  });
});
