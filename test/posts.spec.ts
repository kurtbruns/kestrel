import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { frozenSend, setRow } from "./support/fixtures";
import { AUTH, adminAuth, base, JSON_AUTH, readJson } from "./support/http";

async function createPost(body: unknown): Promise<Response> {
  return SELF.fetch(`${base}/api/posts`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Save a draft, expecting it to land, and read back the saved post. */
async function save(id: string, body: unknown): Promise<any> {
  const res = await SELF.fetch(`${base}/api/posts/${id}`, {
    method: "PUT",
    headers: JSON_AUTH,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return readJson(res);
}

describe("posts + revisions", () => {
  it("requires auth", async () => {
    const res = await SELF.fetch(`${base}/api/posts`, { method: "POST" });
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
      await SELF.fetch(`${base}/api/posts/${post.id}/revisions`, { headers: AUTH }),
    );
    expect(revs.revisions).toHaveLength(1);
  });

  it("creates a new post with an empty subject under the stand-in slug", async () => {
    const res = await createPost({});
    expect(res.status).toBe(201);
    const { post } = await readJson(res);
    expect(post.subject).toBe("");
    expect(post.slug).toMatch(/^post(-\d+)?$/);
  });

  it("writes a new revision per save and advances current_revision", async () => {
    const created = await readJson(await createPost({ subject: "Versioned", markdown: "v1" }));
    const id = created.post.id;

    const upd = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "v2", base_revision: created.revision_id }),
    });
    expect(upd.status).toBe(200);
    const updated = await readJson(upd);
    expect(updated.revision_id).not.toBe(created.revision_id);
    expect(updated.post.current_revision).toBe(updated.revision_id);

    const got = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    expect(got.markdown).toBe("v2");

    const revs = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/revisions`, { headers: AUTH }),
    );
    expect(revs.revisions).toHaveLength(2);

    const r1 = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/revisions/1`, { headers: AUTH }),
    );
    expect(r1.markdown).toBe("v1");
  });

  it("gives each post its own slug, drafts included, numbering a following slug another post holds (SPEC §4)", async () => {
    const a = await readJson(await createPost({ subject: "Dup Title" }));
    const b = await readJson(await createPost({ subject: "Dup Title" }));
    expect([a.post.slug, b.post.slug]).toEqual(["dup-title", "dup-title-2"]);
    // The second says why its address isn't the subject's.
    expect([a.subject_slug_held, b.subject_slug_held]).toEqual([null, "dup-title"]);
  });

  it("numbers a following slug when another post holds the subject's slug, and keeps that number on later saves", async () => {
    await createPost({ subject: "Spring update" });
    const created = await readJson(await createPost({ subject: "" }));
    expect(created.post.slug).toMatch(/^post(-\d+)?$/);
    const saved = await save(created.post.id, {
      subject: "Spring update",
      base_revision: created.revision_id,
    });
    expect(saved.post).toMatchObject({ slug: "spring-update-2", slug_auto: true });
    expect(saved.subject_slug_held).toBe("spring-update");

    // A third post takes -3 and leaves the second alone, and another save doesn't move the second.
    const third = await readJson(await createPost({ subject: "Spring update" }));
    expect(third.post.slug).toBe("spring-update-3");
    const again = await save(created.post.id, {
      markdown: "more",
      base_revision: saved.post.current_revision,
    });
    expect(again.post.slug).toBe("spring-update-2");
  });

  it("has a slug follow the subject until one is set by hand", async () => {
    const created = await readJson(await createPost({ subject: "Follows", markdown: "x" }));
    const id = created.post.id;
    expect(created.post.slug_auto).toBe(true);

    const renamed = await save(id, {
      subject: "Renamed Completely",
      base_revision: created.revision_id,
    });
    expect(renamed.post.slug).toBe("renamed-completely");

    const reslugged = await save(id, {
      slug: "brand-new-slug",
      base_revision: renamed.post.current_revision,
    });
    expect(reslugged.post.slug).toBe("brand-new-slug");
    expect(reslugged.post.slug_auto).toBe(false); // sending a slug sets it by hand

    const kept = await save(id, {
      subject: "Third Name",
      base_revision: reslugged.post.current_revision,
    });
    expect(kept.post.slug).toBe("brand-new-slug");

    const relinked = await save(id, { slug_auto: true, base_revision: kept.post.current_revision });
    expect(relinked.post.slug).toBe("third-name");
    expect(relinked.post.slug_auto).toBe(true);
  });

  it("keeps a slug named on create as set by hand", async () => {
    const { post } = await readJson(
      await createPost({ subject: "Spring update", slug: "spring-update-2027" }),
    );
    expect(post.slug).toBe("spring-update-2027");
    expect(post.slug_auto).toBe(false);
  });

  it("refuses a slug set by hand that is malformed or another post's, and saves nothing (SPEC §4)", async () => {
    await createPost({ subject: "Taken" });
    const created = await readJson(await createPost({ subject: "Mine", markdown: "v1" }));
    const attempt = (slug: string) =>
      SELF.fetch(`${base}/api/posts/${created.post.id}`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify({ slug, markdown: "v2", base_revision: created.revision_id }),
      });
    for (const [slug, status, error] of [
      ["Has Spaces", 400, "slug_invalid"],
      ["trailing-", 400, "slug_invalid"],
      ["taken", 409, "slug_taken"],
    ] as const) {
      const res = await attempt(slug);
      expect(res.status, slug).toBe(status);
      expect(await res.json(), slug).toMatchObject({ error, field: "slug" });
    }
    const read = await readJson(
      await SELF.fetch(`${base}/api/posts/${created.post.id}`, { headers: AUTH }),
    );
    expect(read.post).toMatchObject({ slug: "mine", current_revision: created.revision_id });
  });

  it("lists each post's slug mode as true or false (SPEC §4)", async () => {
    const { post } = await readJson(await createPost({ subject: "Listed Mode" }));
    const { posts } = await readJson(
      await SELF.fetch(`${base}/api/posts?search=Listed%20Mode`, { headers: AUTH }),
    );
    expect(posts.map((p: { id: string; slug_auto: unknown }) => [p.id, p.slug_auto])).toEqual([
      [post.id, true],
    ]);
  });

  it("reads a post saved before slugs recorded their mode as set by hand (SPEC §4)", async () => {
    // A row as an older release wrote it: no slug_auto, so the migration's default applies.
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, subject, status, created_at, updated_at) VALUES ('p-older', 'older-post', 'Older post', 'draft', ?, ?)",
    )
      .bind(now, now)
      .run();
    const { post } = await readJson(
      await SELF.fetch(`${base}/api/posts/p-older`, { headers: AUTH }),
    );
    expect(post.slug).toBe("older-post");
    expect(post.slug_auto).toBe(false);
  });

  it("refuses a slug beside slug_auto: true, and a slug_auto that is not a boolean", async () => {
    const both = await createPost({ subject: "Both", slug: "mine", slug_auto: true });
    expect(both.status).toBe(400);
    expect((await readJson(both)).field).toBe("slug");

    const wrong = await createPost({ subject: "Wrong", slug_auto: "yes" });
    expect(wrong.status).toBe(400);
    expect((await readJson(wrong)).field).toBe("slug_auto");
  });

  it("blocks edits and deletes on a non-draft post (409)", async () => {
    const created = await readJson(await createPost({ subject: "Locked" }));
    const id = created.post.id;
    await env.DB.prepare("UPDATE posts SET status = 'scheduled' WHERE id = ?").bind(id).run();

    const put = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "nope" }),
    });
    expect(put.status).toBe(409);
    // In words the editor shows as they stand, naming the way to edit again (DESIGN §10),
    // under the code for an act that no longer applies, not one to try again.
    expect(await readJson(put)).toEqual({
      error: "post_not_draft",
      message: "This post is scheduled, so it’s locked. Cancel the schedule to edit it.",
    });

    const del = await SELF.fetch(`${base}/api/posts/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(409);
    expect((await readJson(del)).error).toBe("post_not_draft");
  });

  it("says a post whose send has started can't be changed, rather than offering a cancel (SPEC §6)", async () => {
    // The post stays scheduled until its send completes, but the window to cancel has closed.
    const send = await frozenSend(Date.now() + 10 * 60_000);
    await setRow(send.id, { status: "sending", started_at: Date.now() });

    const put = await SELF.fetch(`${base}/api/posts/${send.post_id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "nope" }),
    });
    expect(put.status).toBe(409);
    expect(await readJson(put)).toEqual({
      error: "post_not_draft",
      message: "This post is being sent, so it can’t be changed.",
    });
  });

  it("says a sent post can't be changed", async () => {
    const created = await readJson(await createPost({ subject: "Sent" }));
    const id = created.post.id;
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(id).run();

    const put = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "nope" }),
    });
    expect(put.status).toBe(409);
    expect(await readJson(put)).toEqual({
      error: "post_not_draft",
      message: "This post has been sent, so it can’t be changed.",
    });
  });

  it("deletes a draft and its revisions", async () => {
    const created = await readJson(await createPost({ subject: "Trash", markdown: "x" }));
    const id = created.post.id;
    const del = await SELF.fetch(`${base}/api/posts/${id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(200);
    const got = await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH });
    expect(got.status).toBe(404);
    const revCount: any = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?",
    )
      .bind(id)
      .first();
    expect(revCount.n).toBe(0);
  });

  // Optimistic concurrency (SPEC §4): a save carries the base revision it loaded;
  // if another writer (another tab, or Claude) advanced the draft since, the stale
  // save is rejected 409 rather than silently clobbering the newer one, and a save
  // that names no base is refused 428 rather than landed unchecked.
  const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("rejects a stale save (If-Match) with 409 and names the current revision", async () => {
    const created = await readJson(await createPost({ subject: "Race", markdown: "v1" }));
    const id = created.post.id;
    const rev1 = created.post.current_revision;

    // A concurrent writer — Claude, a service principal (no email) — advances to v2.
    const claudeAuth = await adminAuth({});
    const v2 = await readJson(await put(id, { markdown: "v2", base_revision: rev1 }, claudeAuth));
    const rev2 = v2.post.current_revision;
    expect(rev2).not.toBe(rev1);

    // A client still holding rev1 tries to save — rejected, with the newer revision named.
    const stale = await put(id, { markdown: "stale overwrite" }, { "If-Match": rev1 });
    expect(stale.status).toBe(409);
    const body = await readJson(stale);
    expect(body.error).toBe("stale_revision");
    expect(body.current_revision).toBe(rev2);
    expect(body.author).toBe("service"); // the service principal; the editor maps this to "Claude"
    // The post as it stands, with its text, so the client can re-apply without reading again.
    expect(body.post.id).toBe(id);
    expect(body.post.current_revision).toBe(rev2);
    expect(body.markdown).toBe("v2");

    // The draft is untouched — no clobber.
    const got = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    expect(got.markdown).toBe("v2");
  });

  it("accepts a save whose If-Match is current, and advances the revision", async () => {
    const created = await readJson(await createPost({ subject: "Fresh", markdown: "v1" }));
    const id = created.post.id;
    const ok = await put(id, { markdown: "v2" }, { "If-Match": created.post.current_revision });
    expect(ok.status).toBe(200);
    const updated = await readJson(ok);
    expect(updated.post.current_revision).not.toBe(created.post.current_revision);
    expect(updated.revision_id).toBe(updated.post.current_revision);
  });

  it("accepts base_revision in the body as a header-free fallback", async () => {
    const created = await readJson(await createPost({ subject: "BodyBase", markdown: "v1" }));
    const id = created.post.id;
    const rev1 = created.post.current_revision;

    // Advance so rev1 is stale; this save must land, or the 409 below proves nothing.
    expect((await put(id, { markdown: "v2", base_revision: rev1 })).status).toBe(200);
    const stale = await put(id, { markdown: "nope", base_revision: rev1 });
    expect(stale.status).toBe(409);

    const current = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    const ok = await put(id, { markdown: "v3", base_revision: current.post.current_revision });
    expect(ok.status).toBe(200);
  });

  it("refuses a save with no base revision (428), carrying the post as it stands", async () => {
    const created = await readJson(await createPost({ subject: "NoBase", markdown: "v1" }));
    const id = created.post.id;
    const rev1 = created.post.current_revision;
    // Every way of naming no base, from a person and from Claude (a service principal) alike.
    const claudeAuth = await adminAuth({});
    const attempts: [unknown, Record<string, string>][] = [
      [{ markdown: "v2" }, {}],
      [{ markdown: "v2", base_revision: null }, {}],
      [{ markdown: "v2" }, { "If-Match": "*" }],
      [{ markdown: "v2" }, claudeAuth],
    ];
    for (const [body, headers] of attempts) {
      const res = await put(id, body, headers);
      expect(res.status).toBe(428);
      expect(res.headers.get("ETag")).toBe(`"${rev1}"`);
      const refused = await readJson(res);
      expect(refused.error).toBe("base_required");
      expect(refused.field).toBe("base_revision");
      expect(refused.post).toMatchObject({ id, current_revision: rev1, status: "draft" });
    }
    // Nothing landed, and the refusal's revision is enough to save in one more step.
    const got = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    expect(got.markdown).toBe("v1");
    expect(got.post.current_revision).toBe(rev1);
    expect((await put(id, { markdown: "v2" }, { "If-Match": `"${rev1}"` })).status).toBe(200);
  });

  it("exposes the current revision as an ETag and its author on GET", async () => {
    const created = await readJson(await createPost({ subject: "Tagged", markdown: "x" }));
    const res = await SELF.fetch(`${base}/api/posts/${created.post.id}`, { headers: AUTH });
    expect(res.headers.get("ETag")).toBe(`"${created.post.current_revision}"`);
    const data = await readJson(res);
    expect(data.author).toBe("tester@example.com"); // the human principal (default AUTH) that created it
  });

  // A draft that was scheduled then canceled still has the canceled send (and any
  // deliveries) referencing it; deleting the post must cascade to them, not fault
  // on the FK. Scheduling only leaves a draft behind by way of cancel, so the
  // send here is always a canceled one — a sent post's record can't reach delete.
  it("deletes a draft that had a canceled send, cascading its sends + deliveries", async () => {
    const created = await readJson(
      await createPost({ subject: "Was Scheduled", markdown: "body" }),
    );
    const id = created.post.id;

    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ fire_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
      }),
    );
    const sendId = scheduled.send.id;
    const canceled = await SELF.fetch(`${base}/api/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(canceled.status).toBe(200);
    // A delivery row would exist if the send had begun; insert one so the cascade
    // is exercised even though a cancel-before-fire normally leaves none.
    await env.DB.prepare(
      "INSERT INTO deliveries (send_id, email, status, updated_at) VALUES (?, ?, 'pending', ?)",
    )
      .bind(sendId, "x@example.com", Date.now())
      .run();

    const del = await SELF.fetch(`${base}/api/posts/${id}`, { method: "DELETE", headers: AUTH });
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

describe("posts list: filter, sort, paginate", () => {
  it("returns a page envelope; filters by status; sorts and pages by a whitelisted column", async () => {
    const marker = `plist-${Date.now()}`;
    // Three drafts whose subjects sort A < B < C.
    for (const s of ["A", "B", "C"]) {
      await createPost({ subject: `${marker} ${s}`, markdown: "x" });
    }
    const q = `search=${marker}&sort=title&dir=asc`;

    const p1 = await readJson(
      await SELF.fetch(`${base}/api/posts?${q}&limit=2&offset=0`, { headers: AUTH }),
    );
    expect(p1.posts.map((p: any) => p.subject)).toEqual([`${marker} A`, `${marker} B`]);
    expect(p1.page).toMatchObject({ total: 3, limit: 2, offset: 0, sort: "title", dir: "asc" });

    const p2 = await readJson(
      await SELF.fetch(`${base}/api/posts?${q}&limit=2&offset=2`, { headers: AUTH }),
    );
    expect(p2.posts.map((p: any) => p.subject)).toEqual([`${marker} C`]);

    // Status filter: all three are drafts, none are sent.
    const drafts = await readJson(
      await SELF.fetch(`${base}/api/posts?search=${marker}&status=draft`, { headers: AUTH }),
    );
    expect(drafts.posts).toHaveLength(3);
    const sent = await readJson(
      await SELF.fetch(`${base}/api/posts?search=${marker}&status=sent`, { headers: AUTH }),
    );
    expect(sent.posts).toHaveLength(0);
    expect(sent.page.total).toBe(0);
  });
});
