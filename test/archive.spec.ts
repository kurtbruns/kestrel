import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import { getConfig } from "../src/env";
import { archiveIndexPage, landingPage } from "../src/lib/page";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import {
  ARCHIVE_HEAD_ANCHOR,
  ARCHIVE_MASTHEAD_ANCHOR,
  EMAIL_ONLY_CLOSE,
  EMAIL_ONLY_OPEN,
  UNSUB_SENTINEL,
} from "../src/render/render";
import type { RequestContext } from "../src/router";
import { archiveIndex, archivePage, landing } from "../src/routes/archive";
import { confirmLanding, subscribeForm, unsubscribeLanding } from "../src/routes/public";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";

const base = "https://kestrel.test";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
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
    // No unsubscribe sentinel reaches the page. The built-in template's link is email-only,
    // so it's left out; one outside a region becomes the generic link (tested below).
    expect(body).not.toContain(UNSUB_SENTINEL);
    // The browser-only masthead replaces its inert anchor and links back to the archive
    // index (same origin as the post), not the app landing page.
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

  it("carries the dev-only dashboard pill as browser-only chrome, never in the frozen or sent bytes (I3, §5)", async () => {
    const post = await sendPost("Pill", "you can find it in the dashboard");
    const send = (await latestSentSendForPost(env.DB, post.id))!;
    // The record and the email a reader got hold no trace of the pill or its styles.
    for (const html of [send.rendered_html, fakeOutbox()[0]!.html]) {
      expect(html).not.toContain("r-dev");
      expect(html).not.toContain("Open dashboard");
      expect(html).not.toContain("/dashboard/");
    }

    // The test env is dev-shaped, so the hosted page fills the pill into the masthead
    // slot and its stylesheet into the head slot, the same accent pill the landing
    // page wears.
    const body = await (await SELF.fetch(`${base}/archive/${post.slug}`)).text();
    expect(body).toContain('class="r-dev"');
    expect(body).toContain('href="http://localhost:8787/dashboard/"');
    expect(body).toContain("--k-accent:#3355cc");
    expect(body.indexOf(".r-dev {")).toBeLessThan(body.indexOf("</head>"));
    expect(body.indexOf('class="k-mast"')).toBeLessThan(body.indexOf('class="r-dev"'));
  });

  it("keeps the built-in footer's email-only part in the sent email and leaves it off the archive page", async () => {
    await updateSettings(env.DB, { publication: { address: "12 Marsh Lane" } });
    try {
      const post = await sendPost("Footer", "the post");
      const send = (await latestSentSendForPost(env.DB, post.id))!;
      // The frozen record keeps the whole footer, the region between inert markers.
      expect(send.rendered_html).toContain(EMAIL_ONLY_OPEN);
      expect(send.rendered_html).toContain(EMAIL_ONLY_CLOSE);

      // The sent email carries every part: the recipient's unsubscribe link, view in
      // browser, and the address.
      const [sent] = fakeOutbox();
      expect(sent!.html).toContain("uns-a");
      expect(sent!.html).toContain(">Unsubscribe</a>");
      expect(sent!.html).toContain(">View in browser</a>");
      expect(sent!.html).toContain("12 Marsh Lane");

      // The archive page keeps the post, the sign-off, and "Powered by Kestrel", and
      // leaves out the inbox links and the address.
      const body = await (await SELF.fetch(`${base}/archive/${post.slug}`)).text();
      expect(body).toContain("the post");
      expect(body).toContain('class="signoff"');
      expect(body).toContain("Powered by Kestrel");
      expect(body).not.toContain(">Unsubscribe</a>");
      expect(body).not.toContain(">View in browser</a>");
      expect(body).not.toContain("12 Marsh Lane");
      expect(body).not.toContain("kestrel:email");
    } finally {
      await updateSettings(env.DB, { publication: { address: "" } });
    }
  });

  it("serves a footer outside any region on the archive page, as before regions existed", async () => {
    await updateSettings(env.DB, {
      emailTemplate:
        '{{ .Post.Body }}<p class="foot"><a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></p>',
    });
    try {
      const post = await sendPost("No Region", "the post");
      const send = (await latestSentSendForPost(env.DB, post.id))!;
      expect(send.rendered_html).not.toContain(EMAIL_ONLY_OPEN);
      const body = await (await SELF.fetch(`${base}/archive/${post.slug}`)).text();
      expect(body).toContain('href="http://localhost:8787/unsubscribe"');
    } finally {
      await updateSettings(env.DB, { emailTemplate: "" });
    }
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
  it("features the latest post over the recent ones, linking to canonical archive URLs", async () => {
    const older = await publish("The Older One", 1_000);
    const newer = await publish("The Newer One", 2_000);

    const res = await SELF.fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    // The newest is the feature; the older sits in the recent list. Both link out.
    expect(body).toContain("Latest post");
    expect(body).toContain("The Newer One");
    expect(body).toContain("The Older One");
    expect(body).toContain(`http://localhost:8787/archive/${newer.slug}`);
    expect(body).toContain(`http://localhost:8787/archive/${older.slug}`);
    // The feature (newest) precedes the recent list (older).
    expect(body.indexOf("The Newer One")).toBeLessThan(body.indexOf("The Older One"));
  });

  it("offers a subscribe call to action and a link into the full archive", async () => {
    await publish("A Post", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    expect(body).toContain("Subscribe here");
    expect(body).toContain('href="http://localhost:8787/subscribe"');
    expect(body).toContain("Browse the full archive");
    expect(body).toContain('href="http://localhost:8787/archive"');
  });

  it("shows the dev-only dashboard shortcut on a dev-shaped instance (SPEC §5/§11)", async () => {
    await publish("A Post", 1_000);
    const body = await (await SELF.fetch(`${base}/`)).text();
    // The test env is dev-shaped (fake transport, no Access, dev secret set), so the
    // reader surface injects the local-developer editor shortcut. `/dashboard` here
    // is dev-token-gated, not an Access wall, so this respects §11 — and the paired
    // page-level test below proves it is absent once deployed.
    expect(body).toContain('class="r-dev"');
    expect(body).toContain("http://localhost:8787/dashboard/");
  });

  it("shows an empty state when nothing has been sent", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No posts yet");
    expect(body).not.toContain("Just A Draft");
  });
});

describe("archive index (the full list, §5)", () => {
  it("lists every sent post newest-first, linking to their canonical archive URLs", async () => {
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

  it("shows the dev-only dashboard shortcut on a dev-shaped instance (SPEC §5/§11)", async () => {
    await publish("A Post", 1_000);
    const body = await (await SELF.fetch(`${base}/archive`)).text();
    expect(body).toContain('class="r-dev"');
    expect(body).toContain("http://localhost:8787/dashboard/");
  });

  it("shows an empty state and excludes drafts / scheduled posts", async () => {
    await posts.createPost(env.DB, { subject: "Just A Draft", markdown: "wip" }, "test");
    const res = await SELF.fetch(`${base}/archive`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("No posts yet.");
    expect(body).not.toContain("Just A Draft");
  });

  it("serves the index at both `/archive` and `/archive/` (optional trailing slash)", async () => {
    const post = await publish("A Post", 1_000);
    for (const path of ["/archive", "/archive/"]) {
      const res = await SELF.fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("A Post");
      expect(body).toContain(`http://localhost:8787/archive/${post.slug}`);
    }
  });
});

// The §11 guarantee, proven independent of the test env's dev shape: a deployed
// instance passes no `devDashboardUrl`, so the reader shell renders no admin link
// at all — the public front door never points at the Access-gated editor. The
// SELF.fetch tests above cover the dev-shaped direction (the link IS shown).
describe("reader surface — no admin link once deployed (§11)", () => {
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
      posts: [],
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
// end-to-end, and dropping that gate would break §11 without failing a test.
describe("reader routes gate the pill on config.devMode (§11)", () => {
  function ctxFor(
    devMode: boolean,
    path = "/",
    params: Record<string, string> = {},
  ): RequestContext {
    return {
      req: new Request(`${base}${path}`),
      env,
      ctx: createExecutionContext(),
      url: new URL(`${base}${path}`),
      params,
      config: { ...getConfig(env), devMode },
    };
  }

  it("landing renders the pill only when devMode is true", async () => {
    await publish("A Post", 1_000);
    const on = await (await landing(ctxFor(true))).text();
    const off = await (await landing(ctxFor(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain('class="r-dev"');
    expect(off).not.toContain("/dashboard");
  });

  it("archive index renders the pill only when devMode is true", async () => {
    await publish("A Post", 1_000);
    const on = await (await archiveIndex(ctxFor(true))).text();
    const off = await (await archiveIndex(ctxFor(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain('class="r-dev"');
    expect(off).not.toContain("/dashboard");
  });

  it("a post page renders the pill and its styles only when devMode is true", async () => {
    const post = await publish("A Post", 1_000);
    const ctx = (devMode: boolean) => ctxFor(devMode, `/archive/${post.slug}`, { slug: post.slug });
    const on = await (await archivePage(ctx(true))).text();
    const off = await (await archivePage(ctx(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain("r-dev");
    expect(off).not.toContain("--k-accent");
    expect(off).not.toContain("/dashboard");
  });

  it("the subscribe page renders the pill only when devMode is true", async () => {
    const on = await (await subscribeForm(ctxFor(true, "/subscribe"))).text();
    const off = await (await subscribeForm(ctxFor(false, "/subscribe"))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain('class="r-dev"');
    expect(off).not.toContain("/dashboard");
  });

  // The card pages: confirm and unsubscribe, which a local developer reaches from a
  // link in a test email, and the post 404. Each has its own stylesheet, so the pill
  // brings its own.
  it("the card pages render the pill and its styles only when devMode is true", async () => {
    await ensureSubscriber();
    const cards: [string, (c: RequestContext) => Promise<Response>, string][] = [
      ["confirm (invalid link)", confirmLanding, "/confirm?token=nope"],
      ["unsubscribe (ready)", unsubscribeLanding, "/unsubscribe?token=uns-a"],
      ["unsubscribe (invalid link)", unsubscribeLanding, "/unsubscribe?token=nope"],
      ["post not found", archivePage, "/archive/missing"],
    ];
    for (const [name, handler, path] of cards) {
      const params = { slug: "missing" };
      const on = await (await handler(ctxFor(true, path, params))).text();
      const off = await (await handler(ctxFor(false, path, params))).text();
      expect(on, name).toContain('class="r-dev"');
      expect(on, name).toContain("--k-accent:#3355cc");
      expect(off, name).not.toContain("r-dev");
      expect(off, name).not.toContain("--k-accent");
      expect(off, name).not.toContain("/dashboard");
    }
  });

  it("the one-click unsubscribe POST still answers plain text, with no page chrome", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?token=uns-a`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unsubscribed");
  });
});
