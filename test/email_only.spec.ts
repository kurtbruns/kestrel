// Email only (SPEC §5): a post mailed as usual but left out of the archive index and the
// landing page, its archive address answering nothing. The listing is the post's, chosen when
// it is scheduled and changeable after, a sent post's included, and never part of the frozen
// copy (I3). What each address answers is test/unlisted_links.spec.ts.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { getSend } from "../src/db/sends";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  await seedConfirmed("a@example.com");
});

const DAY = 86_400_000;

/** A draft made through the API, its id. */
async function makeDraft(subject = "The Subject"): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject, markdown: `# ${subject}\n\nbody` }),
    }),
  );
  return created.post.id;
}

const post = async (id: string) =>
  (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }))).post;

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const cancel = async (sendId: string) =>
  expect((await call("POST", `/api/sends/${sendId}/cancel`)).status).toBe(200);

const schedule = (id: string, body: Record<string, unknown> = {}) =>
  call("POST", `/api/posts/${id}/schedule`, {
    fire_at: new Date(Date.now() + DAY).toISOString(),
    ...body,
  });

const setListing = (id: string, body: unknown) => call("PUT", `/api/posts/${id}/settings`, body);

/** A post sent through the sweep, its listing as given: scheduled, then made due and swept. */
async function sendPost(
  subject: string,
  emailOnly: boolean,
): Promise<{ id: string; slug: string; sendId: string }> {
  const id = await makeDraft(subject);
  const { send } = await readJson(await schedule(id, { email_only: emailOnly }));
  await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
    .bind(Date.now() - 1000, send.id)
    .run();
  await sweep(env);
  const p = await post(id);
  return { id, slug: p.slug, sendId: send.id };
}

const page = async (path: string) => (await SELF.fetch(`${base}${path}`)).text();

describe("a post's listing (SPEC §5)", () => {
  it("is in the archive by default, on the post and on its send", async () => {
    const id = await makeDraft();
    expect((await post(id)).email_only).toBe(false);
    const res = await schedule(id);
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.email_only).toBe(false);
    expect((await post(id)).email_only).toBe(false);
  });

  it("is set by scheduling with email_only, and carried on the post and its send", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await schedule(id, { email_only: true }));
    expect(send.email_only).toBe(true);
    expect((await post(id)).email_only).toBe(true);
    const listed = await readJson(await SELF.fetch(`${base}/api/sends`, { headers: AUTH }));
    expect(listed.sends[0].email_only).toBe(true);
  });

  it("is set by Send now's optional body", async () => {
    const id = await makeDraft();
    const res = await call("POST", `/api/posts/${id}/send`, { email_only: true });
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.email_only).toBe(true);
    expect((await post(id)).email_only).toBe(true);
  });

  it("is kept by a schedule that doesn't name it", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await schedule(id, { email_only: true }));
    await cancel(send.id);
    const again = await readJson(await schedule(id));
    expect(again.send.email_only).toBe(true);
  });

  it("is no field of a reschedule, which moves only the time: each setting is a 400 that moves nothing (SPEC §6)", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await schedule(id));
    for (const field of [{ email_only: true }, { slug: "elsewhere" }, { slug_auto: false }]) {
      const res = await call("POST", `/api/sends/${send.id}/reschedule`, {
        fire_at: Date.now() + 2 * DAY,
        ...field,
      });
      expect(res.status, JSON.stringify(field)).toBe(400);
      expect((await readJson(res)).field).toBe(Object.keys(field)[0]);
    }
    expect((await getSend(env.DB, send.id))?.fire_at).toBe(send.fire_at);
    expect((await post(id)).email_only).toBe(false);
  });

  it("changes on a scheduled post through its settings, leaving the send time (SPEC §5)", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await schedule(id));
    const res = await readJson(await setListing(id, { email_only: true }));
    expect(res.changed).toBe(true);
    const now = await readJson(await call("GET", `/api/sends/${send.id}`));
    expect(now.send).toMatchObject({ email_only: true, fire_at: send.fire_at });
  });
});

describe("the public pages and an email-only post (SPEC §5)", () => {
  it("leave it out of the archive index and the landing page, and list the others", async () => {
    await sendPost("Listed Owls", false);
    await sendPost("Quiet Gulls", true);
    for (const path of ["/archive", "/"]) {
      const body = await page(path);
      expect(body, path).toContain("Listed Owls");
      expect(body, path).not.toContain("Quiet Gulls");
    }
  });

  it("serve its page at its unlisted link, asking search engines not to index it, and give it no archive address", async () => {
    const quiet = await sendPost("Quiet Gulls", true);
    const token = (await post(quiet.id)).unlisted_token;
    const res = await SELF.fetch(`${base}/email/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toContain("Quiet Gulls");
    // Never listed, so its archive address never answers.
    expect((await SELF.fetch(`${base}/archive/${quiet.slug}`)).status).toBe(404);
  });

  it("mail it exactly as a listed post", async () => {
    await sendPost("Quiet Gulls", true);
    const outbox = fakeOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe("a@example.com");
    expect(outbox[0]?.subject).toBe("Quiet Gulls");
  });
});

describe("PUT /api/posts/:id/settings (SPEC §5)", () => {
  it("switches a sent post either way, and the lists follow", async () => {
    const sent = await sendPost("Owls", false);
    const off = await setListing(sent.id, { email_only: true });
    expect(off.status).toBe(200);
    const offBody = await readJson(off);
    expect(offBody.changed).toBe(true);
    expect(offBody.post.email_only).toBe(true);
    expect(offBody.post.status).toBe("sent");
    expect(await page("/archive")).not.toContain("Owls");
    const on = await readJson(await setListing(sent.id, { email_only: false }));
    expect(on.changed).toBe(true);
    expect(on.post.email_only).toBe(false);
    expect(await page("/archive")).toContain("Owls");
  });

  it("never re-makes or alters the frozen send, and mails no one (I3)", async () => {
    const sent = await sendPost("Owls", false);
    const before = await getSend(env.DB, sent.sendId);
    const mailed = fakeOutbox().length;
    await setListing(sent.id, { email_only: true });
    const after = await getSend(env.DB, sent.sendId);
    expect(after?.rendered_html).toBe(before?.rendered_html);
    expect(after?.rendered_text).toBe(before?.rendered_text);
    expect(after?.subject).toBe(before?.subject);
    expect(after?.status).toBe("sent");
    expect(after?.completed_at).toBe(before?.completed_at);
    expect(after?.remade_at).toBe(null);
    expect(fakeOutbox()).toHaveLength(mailed);
  });

  it("changes a scheduled post's listing without re-making its email", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await schedule(id));
    const before = await getSend(env.DB, send.id);
    expect((await readJson(await setListing(id, { email_only: true }))).changed).toBe(true);
    const after = await getSend(env.DB, send.id);
    expect(after?.rendered_html).toBe(before?.rendered_html);
    expect(after?.remade_at).toBe(null);
    expect(after?.status).toBe("scheduled");
  });

  it("gives the post's send a new rev, so a client following sends sees the change (SPEC §8)", async () => {
    const sent = await sendPost("Owls", false);
    const { cursor, send } = await readJson(
      await SELF.fetch(`${base}/api/sends/${sent.sendId}`, { headers: AUTH }),
    );
    await setListing(sent.id, { email_only: true });
    const feed = await readJson(
      await SELF.fetch(`${base}/api/sends/feed?since=${encodeURIComponent(cursor)}`, {
        headers: AUTH,
      }),
    );
    const reported = feed.sends.find((s: { id: string }) => s.id === sent.sendId);
    expect(reported?.email_only).toBe(true);
    expect(reported?.rev).toBeGreaterThan(send.rev);
  });

  it("answers a repeat of the listing the post has with changed: false, writing nothing", async () => {
    const sent = await sendPost("Owls", false);
    const before = await getSend(env.DB, sent.sendId);
    const res = await readJson(await setListing(sent.id, { email_only: false }));
    expect(res.changed).toBe(false);
    expect(res.post.email_only).toBe(false);
    expect((await getSend(env.DB, sent.sendId))?.rev).toBe(before?.rev);
  });

  it("refuses a missing or non-boolean email_only with a 400 naming it", async () => {
    const id = await makeDraft();
    for (const body of [{}, { email_only: "yes" }, { email_only: 1 }, { email_only: null }]) {
      const res = await setListing(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const err = await readJson(res);
      expect(err.error).toBe("bad_request");
      expect(err.field).toBe("email_only");
    }
    expect((await posts.getPost(env.DB, id))?.email_only).toBe(false);
  });

  it("refuses a non-boolean email_only on schedule and Send now, scheduling nothing", async () => {
    const id = await makeDraft();
    for (const res of [
      await schedule(id, { email_only: "true" }),
      await call("POST", `/api/posts/${id}/send`, { email_only: "true" }),
    ]) {
      expect(res.status).toBe(400);
      expect((await readJson(res)).field).toBe("email_only");
    }
    expect((await post(id)).status).toBe("draft");
  });

  it("answers 404 for a post that isn't there", async () => {
    const res = await setListing("p_nope", { email_only: true });
    expect(res.status).toBe(404);
  });
});
