// A post's two addresses (SPEC §4, §5): the unlisted link every email carries, which never
// changes, and the archive address, unique to the post from its first save, which answers only
// while the post is listed and is fixed once its send starts.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getPost, setPublishing } from "../src/db/posts";
import { getConfig } from "../src/env";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import { resetDatabase, seedConfirmed, setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  await seedConfirmed("a@example.com");
});

const DAY = 86_400_000;
/** The app's origin, which every link the app builds names (the archive's is the same here). */
const ORIGIN = getConfig(env).appOrigin;

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function makeDraft(subject: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await readJson(
    await call("POST", "/api/posts", { subject, markdown: `# ${subject}\n\nbody`, ...extra }),
  );
  return created.post.id;
}

const read = async (id: string) => readJson(await call("GET", `/api/posts/${id}`));

const setListing = (id: string, body: unknown) => call("PUT", `/api/posts/${id}/settings`, body);

async function schedule(id: string, emailOnly = false): Promise<string> {
  const res = await call("POST", `/api/posts/${id}/schedule`, {
    fire_at: new Date(Date.now() + DAY).toISOString(),
    email_only: emailOnly,
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).send.id;
}

/** Make a scheduled send due and run the sweep, as its fire time would. */
async function fire(sendId: string): Promise<void> {
  await setRow(sendId, { fire_at: Date.now() - 1000 });
  await sweep(env);
}

/** A post sent through the sweep, listed or email only. */
async function sendPost(subject: string, emailOnly = false) {
  const id = await makeDraft(subject);
  const sendId = await schedule(id, emailOnly);
  await fire(sendId);
  const { post } = await read(id);
  return { id, sendId, post };
}

const get = (path: string) => SELF.fetch(`${base}${path}`, { redirect: "manual" });

describe("every email carries the post's unlisted link (SPEC §5)", () => {
  it("as view in browser in a test and in the send, and never the archive address", async () => {
    const id = await makeDraft("Barn Owls");
    const { post } = await read(id);
    const link = `${ORIGIN}/email/${post.unlisted_token}`;
    expect(post.unlisted_token).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);

    await call("POST", `/api/posts/${id}/test`, { to: "me@example.com" });
    const sendId = await schedule(id);
    await fire(sendId);
    const test = fakeOutbox().find((m) => m.to === "me@example.com")!;
    const sent = fakeOutbox().find((m) => m.to === "a@example.com")!;
    for (const email of [test, sent]) {
      expect(email.html).toContain(`href="${link}"`);
      expect(email.text).toContain(`View in browser: ${link}`);
      expect(email.html).not.toContain("/archive/");
    }
  });

  it("is made with the post and never changes, whatever its subject, address, or listing", async () => {
    const id = await makeDraft("First Subject");
    const before = (await read(id)).post;
    const saved = await readJson(
      await call("PUT", `/api/posts/${id}`, {
        subject: "Second Subject",
        slug: "elsewhere",
        base_revision: before.current_revision,
      }),
    );
    await setListing(id, { email_only: true });
    expect(saved.post.unlisted_token).toBe(before.unlisted_token);
    expect((await read(id)).post.unlisted_token).toBe(before.unlisted_token);
    const other = (await read(await makeDraft("First Subject"))).post;
    expect(other.unlisted_token).not.toBe(before.unlisted_token);
  });
});

describe("a post carries its addresses and where it stands for readers (SPEC §4, §5)", () => {
  it("on its read, its saves, the list, and a settings change, a draft included", async () => {
    const config = getConfig(env);
    const archive = (slug: string) => `${config.archiveOrigin}${config.archiveBasePath}/${slug}`;
    const created = await readJson(await call("POST", "/api/posts", { subject: "Barn Owls" }));
    const id = created.post.id;
    const unlisted = `${ORIGIN}/email/${created.post.unlisted_token}`;
    // A draft's address is where it will go, though nothing shows there yet.
    const draft = {
      archive_url: archive("barn-owls"),
      unlisted_url: unlisted,
      published_at: null,
      archive_live: false,
    };
    expect(created.post).toMatchObject(draft);
    expect((await read(id)).post).toMatchObject(draft);
    const saved = await readJson(
      await call("PUT", `/api/posts/${id}`, {
        markdown: "# Barn Owls\n\nmore",
        base_revision: created.post.current_revision,
      }),
    );
    expect(saved.post).toMatchObject(draft);
    expect((await readJson(await call("GET", "/api/posts"))).posts[0]).toMatchObject(draft);
    const moved = await readJson(await setListing(id, { slug: "owls-at-dusk" }));
    expect(moved.post).toMatchObject({ ...draft, archive_url: archive("owls-at-dusk") });
  });

  it("says when it was published and whether its archive address shows it, as the archive serves it", async () => {
    const live = async (id: string) => {
      const { post } = await read(id);
      const listed = (await readJson(await call("GET", "/api/posts"))).posts.find(
        (p: { id: string }) => p.id === id,
      );
      // The read and the list agree, and the flag is what the address actually does.
      expect(listed).toMatchObject({
        published_at: post.published_at,
        archive_live: post.archive_live,
      });
      const page = await get(new URL(post.archive_url).pathname);
      expect(page.status === 200, post.archive_url).toBe(post.archive_live);
      return post;
    };
    const listed = await sendPost("Listed Owls");
    const listedNow = await live(listed.id);
    expect(listedNow.published_at).toEqual(expect.any(Number));
    expect(listedNow.archive_live).toBe(true);

    const quiet = await sendPost("Quiet Gulls", true);
    expect(await live(quiet.id)).toMatchObject({ archive_live: false });
    expect((await read(quiet.id)).post.published_at).toEqual(expect.any(Number));

    // Taken out of the archive, then a send frozen before unlisted links, whose emails carry
    // the archive address, so it shows whatever the listing.
    const off = await readJson(await setListing(listed.id, { email_only: true }));
    expect(off.post.archive_live).toBe(false);
    expect(await live(listed.id)).toMatchObject({ archive_live: false });
    await setRow(listed.sendId, { web_link: "archive" });
    expect(await live(listed.id)).toMatchObject({ archive_live: true });
  });
});

describe("what the unlisted link opens follows the post (SPEC §5)", () => {
  it("answers Nothing here yet before the send starts, as an unknown link does", async () => {
    const id = await makeDraft("Not Yet");
    const { post } = await read(id);
    await schedule(id);
    for (const token of [post.unlisted_token, "0000"]) {
      const res = await get(`/email/${token}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Nothing here yet");
    }
  });

  it("forwards a listed post, temporarily, to its archive address", async () => {
    const { post } = await sendPost("Listed Owls");
    const res = await get(`/email/${post.unlisted_token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/archive/listed-owls`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect((await get("/archive/listed-owls")).status).toBe(200);
  });

  it("never forwards anywhere a request names, and changes nothing when a scanner follows it", async () => {
    const { id, post } = await sendPost("Listed Owls");
    const before = (await read(id)).post;
    const res = await get(
      `/email/${post.unlisted_token}?next=https://evil.example/&url=https://evil.example/`,
    );
    expect(res.headers.get("location")).toBe(`${ORIGIN}/archive/listed-owls`);
    expect((await read(id)).post).toEqual(before);
  });

  it("is an email-only post's page, unindexed", async () => {
    const { post } = await sendPost("Quiet Gulls", true);
    const res = await get(`/email/${post.unlisted_token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toContain(">Quiet Gulls</h1>");
  });
});

describe("the archive address (SPEC §4, §5)", () => {
  it("can change while the post is scheduled, since no email carries it", async () => {
    const id = await makeDraft("Spring Update");
    const sendId = await schedule(id);
    const res = await setListing(id, { slug: "the-spring-letter" });
    expect(res.status).toBe(200);
    expect((await readJson(res)).post).toMatchObject({
      slug: "the-spring-letter",
      slug_auto: false,
    });
    await fire(sendId);
    expect((await get("/archive/the-spring-letter")).status).toBe(200);
    expect((await get("/archive/spring-update")).status).toBe(404);
  });

  it("is fixed while a scheduled email frozen before unlisted links already carries it", async () => {
    const id = await makeDraft("Spring Update");
    const sendId = await schedule(id);
    await setRow(sendId, { web_link: "archive" }); // as 0008 marks a send frozen before it
    const res = await setListing(id, { slug: "the-spring-letter" });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ error: "slug_permanent", field: "slug" });
    expect((await read(id)).post.slug).toBe("spring-update");
    // Naming the address it has, or changing only the listing, is still fine.
    expect((await setListing(id, { slug: "spring-update", email_only: true })).status).toBe(200);
  });

  it("writes only the settings a change names, so a concurrent change to another stands", async () => {
    const id = await makeDraft("Spring Update");
    const stale = await getPost(env.DB, id);
    await setListing(id, { slug: "the-spring-letter" }); // another writer, after the read
    await setPublishing(env.DB, stale!, { emailOnly: true });
    const { post } = await read(id);
    expect(post).toMatchObject({ slug: "the-spring-letter", email_only: true });
  });

  it("holds the address once the send starts, even against a change checked just before", async () => {
    const id = await makeDraft("Spring Update");
    const sendId = await schedule(id);
    const checked = await getPost(env.DB, id); // the check sees a scheduled post
    await fire(sendId);
    const outcome = await setPublishing(env.DB, checked!, {
      emailOnly: true,
      slug: { slug: "the-spring-letter", auto: false },
    });
    // Refused whole, so the caller can say so: the listing that rode with it isn't written either.
    expect(outcome).toBe("address_fixed");
    expect((await read(id)).post).toMatchObject({ slug: "spring-update", email_only: false });
  });

  it("answers a post deleted after the check as missing, not as a fixed address", async () => {
    const id = await makeDraft("Gone Soon");
    const checked = await getPost(env.DB, id);
    await call("DELETE", `/api/posts/${id}`); // another tab, between the check and the write
    expect(await setPublishing(env.DB, checked!, { emailOnly: true })).toBe("missing");
  });

  it("lets a listing change land after the send starts when it names the address the post has (SPEC §5)", async () => {
    const id = await makeDraft("Spring Update");
    const sendId = await schedule(id);
    const checked = await getPost(env.DB, id);
    await fire(sendId);
    // As a settings form sends it: every field, the slug unchanged.
    const outcome = await setPublishing(env.DB, checked!, {
      emailOnly: true,
      slug: { slug: "spring-update", auto: checked!.slug_auto },
    });
    expect(outcome).toBe("changed");
    expect((await read(id)).post).toMatchObject({ slug: "spring-update", email_only: true });
    const res = await setListing(id, { email_only: false, slug: "spring-update" });
    expect(res.status).toBe(200);
    expect((await readJson(res)).changed).toBe(true);
  });

  it("is chosen again, not refused, when two posts with one subject are made at once (SPEC §4)", async () => {
    // Each resolves the same free slug before either writes; the one the index refuses never
    // named a slug, so it takes the next number rather than a 409.
    const made = await Promise.all(
      [1, 2, 3].map(() => call("POST", "/api/posts", { subject: "Weekly Update" })),
    );
    expect(made.map((r) => r.status)).toEqual([201, 201, 201]);
    const slugs = await Promise.all(made.map(async (r) => (await readJson(r)).post.slug));
    expect([...slugs].sort()).toEqual(["weekly-update", "weekly-update-2", "weekly-update-3"]);
  });

  it("says the subject's address was taken until the post is published, then not, since its address is fixed (SPEC §4)", async () => {
    await makeDraft("Spring Update");
    const id = await makeDraft("Spring Update");
    expect(await read(id)).toMatchObject({
      post: { slug: "spring-update-2" },
      subject_slug_held: "spring-update",
    });
    const sendId = await schedule(id);
    expect((await read(id)).subject_slug_held).toBe("spring-update"); // scheduled: still movable
    await fire(sendId);
    expect((await read(id)).subject_slug_held).toBeNull();
  });

  it("is numbered for a new post kept off its subject with no slug of its own (SPEC §4)", async () => {
    await makeDraft("Weekly Update");
    const res = await call("POST", "/api/posts", { subject: "Weekly Update", slug_auto: false });
    expect(res.status).toBe(201);
    expect((await readJson(res)).post).toMatchObject({ slug: "weekly-update-2", slug_auto: false });
  });

  it("is refused, not renamed, when malformed or another post's, wherever it is set", async () => {
    await makeDraft("Taken Name");
    const id = await makeDraft("Mine");
    const refusals = [
      await setListing(id, { slug: "taken-name" }),
      await call("POST", `/api/posts/${id}/schedule`, {
        fire_at: new Date(Date.now() + DAY).toISOString(),
        slug: "Not A Slug",
      }),
      await call("POST", `/api/posts/${id}/send`, { slug: "taken-name" }),
    ];
    expect(
      await Promise.all(refusals.map(async (r) => [r.status, (await readJson(r)).error])),
    ).toEqual([
      [409, "slug_taken"],
      [400, "slug_invalid"],
      [409, "slug_taken"],
    ]);
    // Nothing was scheduled or renamed.
    expect((await read(id)).post).toMatchObject({ slug: "mine", status: "draft" });
  });

  it("is set with Schedule, in the same act, and a refused schedule sets nothing", async () => {
    const id = await makeDraft("Mine");
    const tooSoon = await call("POST", `/api/posts/${id}/schedule`, {
      fire_at: new Date(Date.now() + 1000).toISOString(),
      slug: "my-letter",
    });
    expect(tooSoon.status).toBe(400);
    expect((await read(id)).post.slug).toBe("mine");
    const res = await call("POST", `/api/posts/${id}/schedule`, {
      fire_at: new Date(Date.now() + DAY).toISOString(),
      slug: "my-letter",
      email_only: false,
    });
    expect(res.status).toBe(201);
    expect((await read(id)).post).toMatchObject({ slug: "my-letter", status: "scheduled" });
  });

  it("is fixed once the send starts: a change to it is refused, and naming it again is fine", async () => {
    const { id } = await sendPost("Kept Address");
    for (const body of [{ slug: "moved" }, { slug_auto: true }]) {
      const res = await setListing(id, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((await readJson(res)).error).toBe("slug_permanent");
    }
    const same = await setListing(id, { slug: "kept-address" });
    expect(same.status).toBe(200);
    expect((await readJson(same)).changed).toBe(false);
  });

  it("is taken down by email only, stays the post's, and comes back when added to the archive again", async () => {
    const { id, post } = await sendPost("Owls");
    const off = await readJson(await setListing(id, { email_only: true }));
    expect(off.changed).toBe(true);
    expect(off.post).toMatchObject({ email_only: true, slug: "owls" });
    // Shared links stop working; the email's link opens the page.
    expect((await get("/archive/owls")).status).toBe(404);
    expect((await get(`/email/${post.unlisted_token}`)).status).toBe(200);

    // Another post can't take the address meanwhile.
    const rival = await makeDraft("Something else");
    const taken = await setListing(rival, { slug: "owls" });
    expect(taken.status).toBe(409);

    const on = await readJson(await setListing(id, { email_only: false }));
    expect(on.post).toMatchObject({ email_only: false, slug: "owls" });
    expect((await get("/archive/owls")).status).toBe(200);
    expect((await get(`/email/${post.unlisted_token}`)).headers.get("location")).toBe(
      `${ORIGIN}/archive/owls`,
    );
  });

  it("is re-checked on every view, so a listing change takes effect at once", async () => {
    const { post } = await sendPost("Fresh");
    const page = await get("/archive/fresh");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const quiet = await sendPost("Quiet", true);
    const unlisted = await get(`/email/${quiet.post.unlisted_token}`);
    expect(unlisted.headers.get("cache-control")).toBe("no-cache");
    expect(post.slug).toBe("fresh");
  });

  it("answers whatever the listing for a post whose email carries it, as one sent before unlisted links does", async () => {
    const { id, sendId } = await sendPost("Older Post");
    // A send frozen before unlisted links: its email links the archive address.
    await setRow(sendId, { web_link: "archive" });
    await setListing(id, { email_only: true });
    const res = await get("/archive/older-post");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const view = (await readJson(await call("GET", `/api/sends/${sendId}`))).send;
    expect(view.links.archive).toBe(`${ORIGIN}/archive/older-post`);
    // The view says which address its email carries, so a client words it to match.
    expect(view.web_link).toBe("archive");
  });

  it("is reported on a send's view only while it answers, beside the unlisted link", async () => {
    const { id, sendId, post } = await sendPost("Reported");
    const view = async () => (await readJson(await call("GET", `/api/sends/${sendId}`))).send;
    expect((await view()).links).toMatchObject({
      archive: `${ORIGIN}/archive/reported`,
      unlisted: `${ORIGIN}/email/${post.unlisted_token}`,
    });
    await setListing(id, { email_only: true });
    expect((await view()).links).toMatchObject({
      archive: null,
      unlisted: `${ORIGIN}/email/${post.unlisted_token}`,
    });
  });
});
