import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { getConfig } from "../src/env";
import { archiveIndexPage, landingPage } from "../src/lib/page";
import { clearFakeOutbox } from "../src/providers/fake";
import { ARCHIVE_HEAD_ANCHOR, ARCHIVE_MASTHEAD_ANCHOR, UNSUB_SENTINEL } from "../src/render/render";
import type { RequestContext } from "../src/router";
import { archiveIndex, landing } from "../src/routes/archive";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";

const base = "https://kestrel.test";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
  clearFakeOutbox();
});

async function sendPost(title: string, markdown: string): Promise<posts.PostRow> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','cfm-a','uns-a',?,?)",
  )
    .bind(now, now)
    .run();
  const { post } = await posts.createPost(env.DB, { subject: title, markdown }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

describe("archive / view-in-browser", () => {
  it("serves the frozen content unchanged, with the sentinel and masthead anchor substituted (I3)", async () => {
    const post = await sendPost("Archive Me", "# Hello\n\nthe permanent record");
    const send = (await latestSentSendForPost(env.DB, post.id))!;
    // The sent/frozen record is masthead-free: the anchor is inert, no chrome baked in.
    expect(send.rendered_html).toContain(ARCHIVE_MASTHEAD_ANCHOR);
    expect(send.rendered_html).not.toContain('class="k-mast"');

    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    // Reviewed content is served unchanged (the template styles headings, so the
    // <h1> now carries an inline serif style; the text and structure are intact).
    expect(body).toContain(">Hello</h1>");
    expect(body).toContain("the permanent record");
    // The unsubscribe sentinel is substituted for a generic link.
    expect(body).not.toContain(UNSUB_SENTINEL);
    expect(body).toContain("/unsubscribe");
    // The browser-only masthead replaces its inert anchor and links back to the archive
    // index (same origin as the issue), not the app landing page.
    expect(body).not.toContain(ARCHIVE_MASTHEAD_ANCHOR);
    expect(body).toContain('class="k-mast"');
    expect(body).toContain('href="http://localhost:8787/archive"');
  });

  it("loads the display font + reader ground as browser-only chrome, never in the sent bytes (I3)", async () => {
    const post = await sendPost("Fonts", "# Heading\n\nbody copy");
    const send = (await latestSentSendForPost(env.DB, post.id))!;
    // The frozen/sent bytes style headings with a system serif (Georgia, inlined by
    // the template) but load no web font — only the inert head anchor, so an inbox
    // never fetches a third-party font.
    expect(send.rendered_html).toContain(ARCHIVE_HEAD_ANCHOR);
    expect(send.rendered_html).toContain("Georgia");
    expect(send.rendered_html).not.toContain("fonts.googleapis.com");

    const body = await (await SELF.fetch(`${base}/archive/${post.slug}`)).text();
    // The hosted page fills the anchor: it loads Fraunces and lands on the reader ground.
    expect(body).not.toContain(ARCHIVE_HEAD_ANCHOR);
    expect(body).toContain("fonts.googleapis.com/css2?family=Fraunces");
    expect(body).toContain("background:#fbfbfa!important");
  });

  it("404s for an unknown slug", async () => {
    const res = await SELF.fetch(`${base}/archive/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("404s for a post that hasn't been sent yet", async () => {
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Draft Only", markdown: "wip" },
      "test",
    );
    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(404);
  });
});

async function ensureSubscriber(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','cfm-a','uns-a',?,?)",
  )
    .bind(now, now)
    .run();
}

async function publish(subject: string, completedAt: number): Promise<posts.PostRow> {
  await ensureSubscriber();
  const { post } = await posts.createPost(env.DB, { subject, markdown: `# ${subject}` }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  // Pin completed_at so ordering is deterministic (sweep uses wall-clock ms).
  await env.DB.prepare("UPDATE sends SET completed_at = ? WHERE post_id = ?")
    .bind(completedAt, post.id)
    .run();
  return post;
}

describe("landing page (the public front door, §5)", () => {
  it("features the latest issue over the recent ones, linking to canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    // The newest is the feature; the older sits in the recent list. Both link out.
    expect(body).toContain("Latest issue");
    expect(body).toContain("The Newer One");
    expect(body).toContain("The Older One");
    expect(body).toContain(`http://localhost:8787/archive/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/archive/${older.slug}`);
    // The feature (newest) precedes the recent list (older).
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("offers a subscribe call to action and a link into the full archive", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    expect(body).toContain("Subscribe here");
    expect(body).toContain('href="http://localhost:8787/subscribe"');
    expect(body).toContain("Browse the full archive");
    expect(body).toContain('href="http://localhost:8787/archive"');
  });

  it("shows the dev-only dashboard shortcut on a dev-shaped instance (SPEC §5/§10)", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    // The test env is dev-shaped (fake transport, no Access, dev secret set), so the
    // reader surface injects the local-developer editor shortcut. `/dashboard` here
    // is dev-token-gated, not an Access wall, so this respects §10 — and the paired
    // page-level test below proves it is absent once deployed.
    expect(body).toContain('class="r-dev"');
    expect(body).toContain("http://localhost:8787/dashboard/");
  });

  it("shows an empty state when nothing has been sent", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No issues yet");
    expect(body).not.toContain("Just A Draft");
  });
});

describe("archive index (the full list, §5)", () => {
  it("lists every sent issue newest-first, linking to their canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    expect(body).toContain("The Older One");
    expect(body).toContain("The Newer One");
    expect(body).toContain(`http://localhost:8787/archive/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/archive/${older.slug}`);
    // Newest first.
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("shows the dev-only dashboard shortcut on a dev-shaped instance (SPEC §5/§10)", async () => {
    await publish("An Issue", 1_000);
    const body = await (await SELF.fetch(`${base}/archive`)).text();
    expect(body).toContain('class="r-dev"');
    expect(body).toContain("http://localhost:8787/dashboard/");
  });

  it("shows an empty state and excludes drafts / scheduled posts", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/archive`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No issues yet.");
    expect(body).not.toContain("Just A Draft");
  });

  it("serves the index at both `/archive` and `/archive/` (optional trailing slash)", async () => {
    const post = await publish("An Issue", 1_000);
    for (const path of ["/archive", "/archive/"]) {
      const res = await SELF.fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("An Issue");
      expect(body).toContain(`http://localhost:8787/archive/${post.slug}`);
    }
  });
});

// The §10 guarantee, proven independent of the test env's dev shape: a deployed
// instance passes no `devDashboardUrl`, so the reader shell renders no admin link
// at all — the public front door never points at the Access-gated editor. The
// SELF.fetch tests above cover the dev-shaped direction (the link IS shown).
describe("reader surface — no admin link once deployed (§10)", () => {
  const identity = { name: "The Publication" };

  it("landing page omits the dashboard link when devDashboardUrl is unset", async () => {
    const withLink = await landingPage({
      identity,
      subscribeUrl: "https://app.example/subscribe",
      homeUrl: "https://app.example/",
      archiveUrl: "https://app.example/archive",
      recent: [],
      devDashboardUrl: "https://app.example/dashboard/",
    }).text();
    const deployed = await landingPage({
      identity,
      subscribeUrl: "https://app.example/subscribe",
      homeUrl: "https://app.example/",
      archiveUrl: "https://app.example/archive",
      recent: [],
    }).text();
    expect(withLink).toContain("/dashboard/");
    expect(withLink).toContain('class="r-dev"');
    // The tooltip spells out the dev-only scope for anyone who wonders if it ships.
    expect(withLink).toContain("Shown only on your local dev server");
    expect(deployed).not.toContain("/dashboard");
    expect(deployed).not.toContain('class="r-dev"');
  });

  it("archive index omits the dashboard link when devDashboardUrl is unset", async () => {
    const deployed = await archiveIndexPage({
      identity,
      subscribeUrl: "https://app.example/subscribe",
      homeUrl: "https://app.example/",
      issues: [],
    }).text();
    expect(deployed).not.toContain("/dashboard");
    expect(deployed).not.toContain('class="r-dev"');
  });
});

// The two guarantees above cover the shell in isolation. This closes the loop at
// the ROUTE level: the real landing/archive handlers must gate the pill on
// `config.devMode`. The Vitest env is always dev-shaped, so we drive the handlers
// directly with a fabricated config to exercise BOTH branches — the deployed
// (devMode:false) branch of `devDashboardUrl(config)` is otherwise never hit
// end-to-end, and dropping that gate would break §10 without failing a test.
describe("reader routes gate the pill on config.devMode (§10)", () => {
  function ctxFor(devMode: boolean): RequestContext {
    return {
      req: new Request(`${base}/`),
      env,
      ctx: createExecutionContext(),
      url: new URL(`${base}/`),
      params: {},
      config: { ...getConfig(env), devMode },
    };
  }

  it("landing renders the pill only when devMode is true", async () => {
    await publish("An Issue", 1_000);
    const on = await (await landing(ctxFor(true))).text();
    const off = await (await landing(ctxFor(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain('class="r-dev"');
    expect(off).not.toContain("/dashboard");
  });

  it("archive index renders the pill only when devMode is true", async () => {
    await publish("An Issue", 1_000);
    const on = await (await archiveIndex(ctxFor(true))).text();
    const off = await (await archiveIndex(ctxFor(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain('class="r-dev"');
    expect(off).not.toContain("/dashboard");
  });
});
