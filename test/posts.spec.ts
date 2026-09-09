import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const AUTH = { Authorization: "Bearer test-bearer-token" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

async function createPost(body: unknown): Promise<Response> {
  return SELF.fetch(`${base}/posts`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("posts + revisions", () => {
  it("requires auth", async () => {
    const res = await SELF.fetch(`${base}/posts`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a draft with a derived slug and a first revision", async () => {
    const res = await createPost({ subject: "Hello World", markdown: "# hi" });
    expect(res.status).toBe(201);
    const { post, revision_id } = await readJson(res);
    expect(post.status).toBe("draft");
    expect(post.slug).toBe("hello-world");
    expect(post.current_revision).toBe(revision_id);

    const revs = await readJson(
      await SELF.fetch(`${base}/posts/${post.id}/revisions`, { headers: AUTH }),
    );
    expect(revs.revisions).toHaveLength(1);
  });

  it("writes a new revision per save and advances current_revision", async () => {
    const created = await readJson(await createPost({ subject: "Versioned", markdown: "v1" }));
    const id = created.post.id;

    const upd = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "v2" }),
    });
    expect(upd.status).toBe(200);
    const updated = await readJson(upd);
    expect(updated.revision_id).not.toBe(created.revision_id);
    expect(updated.post.current_revision).toBe(updated.revision_id);

    const got = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
    expect(got.markdown).toBe("v2");

    const revs = await readJson(
      await SELF.fetch(`${base}/posts/${id}/revisions`, { headers: AUTH }),
    );
    expect(revs.revisions).toHaveLength(2);

    const r1 = await readJson(
      await SELF.fetch(`${base}/posts/${id}/revisions/1`, { headers: AUTH }),
    );
    expect(r1.markdown).toBe("v1");
  });

  it("deduplicates slugs", async () => {
    const a = await readJson(await createPost({ subject: "Dup Title" }));
    const b = await readJson(await createPost({ subject: "Dup Title" }));
    expect(a.post.slug).toBe("dup-title");
    expect(b.post.slug).toBe("dup-title-2");
  });

  it("keeps the slug stable across a subject edit unless overridden", async () => {
    const created = await readJson(await createPost({ subject: "Stable", markdown: "x" }));
    const id = created.post.id;

    const renamed = await readJson(
      await SELF.fetch(`${base}/posts/${id}`, {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ subject: "Renamed Completely" }),
      }),
    );
    expect(renamed.post.slug).toBe("stable");

    const reslugged = await readJson(
      await SELF.fetch(`${base}/posts/${id}`, {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ slug: "brand-new-slug" }),
      }),
    );
    expect(reslugged.post.slug).toBe("brand-new-slug");
  });

  it("blocks edits and deletes on a non-draft post (409)", async () => {
    const created = await readJson(await createPost({ subject: "Locked" }));
    const id = created.post.id;
    await env.DB.prepare("UPDATE posts SET status = 'scheduled' WHERE id = ?").bind(id).run();

    const put = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "nope" }),
    });
    expect(put.status).toBe(409);

    const del = await SELF.fetch(`${base}/posts/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(409);
  });

  it("deletes a draft and its revisions", async () => {
    const created = await readJson(await createPost({ subject: "Trash", markdown: "x" }));
    const id = created.post.id;
    const del = await SELF.fetch(`${base}/posts/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(200);
    const got = await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH });
    expect(got.status).toBe(404);
    const revCount: any = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?",
    )
      .bind(id)
      .first();
    expect(revCount.n).toBe(0);
  });

  // A draft that was scheduled then canceled still has the canceled send (and any
  // deliveries) referencing it; deleting the post must cascade to them, not fault
  // on the FK. Scheduling only leaves a draft behind by way of cancel, so the
  // send here is always a canceled one — a sent issue's record can't reach delete.
  it("deletes a draft that had a canceled send, cascading its sends + deliveries", async () => {
    const created = await readJson(
      await createPost({ subject: "Was Scheduled", markdown: "body" }),
    );
    const id = created.post.id;

    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ fire_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
      }),
    );
    const sendId = scheduled.send.id;
    await SELF.fetch(`${base}/sends/${sendId}/cancel`, { method: "POST", headers: AUTH });
    // A delivery row would exist if the send had begun; insert one so the cascade
    // is exercised even though a cancel-before-fire normally leaves none.
    await env.DB.prepare(
      "INSERT INTO deliveries (id, send_id, email, status, updated_at) VALUES (?, ?, ?, 'pending', ?)",
    )
      .bind("del-cascade", sendId, "x@example.com", Date.now())
      .run();

    const del = await SELF.fetch(`${base}/posts/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(200);

    const counts: any = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE id = ?1) AS posts,
         (SELECT COUNT(*) FROM sends WHERE post_id = ?1) AS sends,
         (SELECT COUNT(*) FROM deliveries WHERE send_id = ?2) AS deliveries`,
    )
      .bind(id, sendId)
      .first();
    expect(counts).toMatchObject({ posts: 0, sends: 0, deliveries: 0 });
  });
});
