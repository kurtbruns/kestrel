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
import {
  confirmLanding,
  subscribe,
  subscribeForm,
  unsubscribe,
  unsubscribeLanding,
} from "../src/routes/public";
import { readerIdentity } from "../src/routes/reader";
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

async function publish(subject: string, startedAt: number): Promise<posts.PostRow> {
  await ensureSubscriber();
  const { post } = await posts.createPost(env.DB, { subject, markdown: `# ${subject}` }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  // Pin started_at, the public date, so ordering is deterministic (sweep uses wall-clock ms).
  await env.DB.prepare("UPDATE sends SET started_at = ? WHERE post_id = ?")
    .bind(startedAt, post.id)
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
  it("lists every published post newest-first, linking to their canonical archive URLs", async () => {
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

describe("a post is published when its send starts (§5)", () => {
  const JAN_5 = Date.UTC(2026, 0, 5, 12);
  const JAN_7 = Date.UTC(2026, 0, 7, 12);

  /** A post frozen for later, so its send sits `scheduled` until a test moves it. */
  async function frozenPost(subject: string): Promise<{ post: posts.PostRow; sendId: string }> {
    await ensureSubscriber();
    const { post } = await posts.createPost(env.DB, { subject, markdown: `# ${subject}` }, "test");
    const send = await freeze(env, getConfig(env), post, Date.now() + 3_600_000);
    return { post, sendId: send.id };
  }

  async function reader(): Promise<{
    page: (slug: string) => Promise<Response>;
    index: string;
    landing: string;
  }> {
    return {
      page: (slug) => SELF.fetch(`${base}/archive/${slug}`),
      index: await (await SELF.fetch(`${base}/archive`)).text(),
      landing: await (await SELF.fetch(`${base}/`)).text(),
    };
  }

  it("serves a send still going out at its archive URL, in the index and on the landing page, dated by its start", async () => {
    const { post, sendId } = await frozenPost("Going Out");
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(JAN_5, sendId)
      .run();
    const send = (await env.DB.prepare("SELECT rendered_html FROM sends WHERE id = ?")
      .bind(sendId)
      .first<{ rendered_html: string }>())!;
    expect(send.rendered_html).toContain(">Going Out</h1>");

    const r = await reader();
    const res = await r.page(post.slug);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The same frozen copy the email carries, with the masthead dated by the start.
    expect(body).toContain(">Going Out</h1>");
    expect(body).toContain('class="k-mast"');
    expect(body).toContain("January 5, 2026");
    for (const list of [r.index, r.landing]) {
      expect(list).toContain("Going Out");
      expect(list).toContain(`http://localhost:8787/archive/${post.slug}`);
      expect(list).toContain("January 5, 2026");
    }
  });

  it("dates a finished send by when it started, not when it completed", async () => {
    const { post, sendId } = await frozenPost("Long Send");
    await env.DB.prepare(
      "UPDATE sends SET status = 'sent', started_at = ?, completed_at = ? WHERE id = ?",
    )
      .bind(JAN_5, JAN_7, sendId)
      .run();
    const r = await reader();
    const body = await (await r.page(post.slug)).text();
    for (const html of [body, r.index, r.landing]) {
      expect(html).toContain("January 5, 2026");
      expect(html).not.toContain("January 7, 2026");
    }
  });

  it("keeps a scheduled or canceled post unpublished", async () => {
    const scheduled = await frozenPost("Still Scheduled");
    const canceled = await frozenPost("Called Off");
    await env.DB.prepare("UPDATE sends SET status = 'canceled' WHERE id = ?")
      .bind(canceled.sendId)
      .run();
    const r = await reader();
    for (const { post } of [scheduled, canceled]) {
      expect((await r.page(post.slug)).status).toBe(404);
    }
    for (const list of [r.index, r.landing]) {
      expect(list).toContain("No posts yet");
      expect(list).not.toContain("Still Scheduled");
      expect(list).not.toContain("Called Off");
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
    expect(deployed).not.toContain("r-dev");
    expect(deployed).not.toContain("--k-accent");
  });

  it("archive index omits the dashboard link when devDashboardUrl is unset", async () => {
    const deployed = await archiveIndexPage({
      identity,
      subscribeUrl: "https://app.example/subscribe",
      homeUrl: "https://app.example/",
      posts: [],
    }).text();
    expect(deployed).not.toContain("/dashboard");
    expect(deployed).not.toContain("r-dev");
    expect(deployed).not.toContain("--k-accent");
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
    init?: RequestInit,
  ): RequestContext {
    return {
      req: new Request(`${base}${path}`, init),
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
    expect(off).not.toContain("r-dev");
    expect(off).not.toContain("--k-accent");
    expect(off).not.toContain("/dashboard");
  });

  it("archive index renders the pill only when devMode is true", async () => {
    await publish("A Post", 1_000);
    const on = await (await archiveIndex(ctxFor(true))).text();
    const off = await (await archiveIndex(ctxFor(false))).text();
    expect(on).toContain('class="r-dev"');
    expect(off).not.toContain("r-dev");
    expect(off).not.toContain("--k-accent");
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
    expect(off).not.toContain("r-dev");
    expect(off).not.toContain("--k-accent");
    expect(off).not.toContain("/dashboard");
  });

  // The message pages: confirm and unsubscribe, which a reader (or a local developer)
  // reaches from a link in an email, and the post 404, plus the subscribe form's error
  // page. All wear the reader shell, so each must carry the pill only in dev.
  it("the message pages render the pill and its styles only when devMode is true", async () => {
    await ensureSubscriber();
    const now = Date.now();
    // A pending subscriber with a live link (the confirm page's "ready" state), one
    // whose link lapsed long ago ("expired"), and one already unsubscribed.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirm_sent_at) VALUES ('p','p@example.com','pending','cfm-p','uns-p',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirm_sent_at) VALUES ('x','x@example.com','pending','cfm-x','uns-x',?,1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, unsubscribed_at) VALUES ('u','u@example.com','unsubscribed',NULL,'uns-u',?,?)",
      ).bind(now, now),
    ]);
    const html = { method: "POST", headers: { accept: "text/html" } };
    const badForm = {
      method: "POST",
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "email=not-an-email",
    };
    const { name: publication } = await readerIdentity(ctxFor(false), getConfig(env));
    // Each row: the case, its handler and path, what only that state's page shows (so
    // the row provably reached it: its headline, and its form where it has one), its
    // status, and the request's method, headers, and body.
    const cards: [
      string,
      (c: RequestContext) => Promise<Response>,
      string,
      string[],
      number,
      RequestInit?,
    ][] = [
      [
        "confirm (ready)",
        confirmLanding,
        "/confirm?token=cfm-p",
        [
          `Confirm your subscription to ${publication}`,
          '<form class="r-form" method="post" action="/confirm">',
          '<button class="r-btn" type="submit">Confirm subscription</button>',
        ],
        200,
      ],
      ["confirm (confirmed)", confirmLanding, "/confirm?token=cfm-a", ["You’re subscribed"], 200],
      [
        "confirm (expired)",
        confirmLanding,
        "/confirm?token=cfm-x",
        [
          "This link has expired",
          '<form class="r-form" method="post" action="/subscribe">',
          '<button class="r-btn" type="submit">Send a new link</button>',
        ],
        410,
      ],
      [
        "confirm (invalid link)",
        confirmLanding,
        "/confirm?token=nope",
        ["This link is invalid"],
        400,
      ],
      [
        "unsubscribe (ready)",
        unsubscribeLanding,
        "/unsubscribe?token=uns-a",
        [
          `Unsubscribe from ${publication}?`,
          '<form class="r-form" method="post" action="/unsubscribe?token=uns-a">',
          '<button class="r-btn" type="submit">Unsubscribe</button>',
        ],
        200,
      ],
      [
        "unsubscribe (already)",
        unsubscribeLanding,
        "/unsubscribe?token=uns-u",
        ["You’re unsubscribed"],
        200,
      ],
      [
        "unsubscribe (invalid link)",
        unsubscribeLanding,
        "/unsubscribe?token=nope",
        ["This link is invalid"],
        400,
      ],
      // The POST's page for a person. It unsubscribes `uns-p`, so it runs after the
      // pages that read that subscriber, and repeating it answers the same page.
      [
        "unsubscribe POST (invalid link)",
        unsubscribe,
        "/unsubscribe?token=nope",
        ["This link is invalid"],
        400,
        html,
      ],
      [
        "unsubscribe POST (done)",
        unsubscribe,
        "/unsubscribe?token=uns-p",
        ["You’re unsubscribed"],
        200,
        html,
      ],
      ["subscribe form", subscribeForm, "/subscribe", [`Subscribe to ${publication}`], 200],
      [
        "subscribe (bad address)",
        subscribe,
        "/subscribe",
        ["doesn’t look like an email"],
        400,
        badForm,
      ],
      ["post not found", archivePage, "/archive/missing", ["Not found"], 404],
    ];
    for (const [name, handler, path, shows, status, init] of cards) {
      const params = { slug: "missing" };
      // A fresh Request per call, since a form body can be read only once.
      const on = await (await handler(ctxFor(true, path, params, init))).text();
      const offRes = await handler(ctxFor(false, path, params, init));
      const off = await offRes.text();
      for (const shown of shows) {
        expect(on, name).toContain(shown);
      }
      expect(offRes.status, name).toBe(status);
      // The reader shell, with the publication's identity and no subscribe CTA.
      expect(off, name).toContain('class="r-mast"');
      expect(off, name).toContain(` · ${publication}</title>`);
      expect(off, name).not.toContain('class="r-sub"');
      if (handler === subscribeForm || handler === subscribe) {
        // The subscribe pages show no one's address, so they stay briefly cacheable
        // and indexable like the rest of the public surface.
        expect(offRes.headers.get("cache-control"), name).toBe("public, max-age=300");
        expect(offRes.headers.get("x-robots-tag"), name).toBeNull();
      } else {
        // Some show the reader's address: never cached, never indexed.
        expect(offRes.headers.get("cache-control"), name).toBe("no-store");
        expect(offRes.headers.get("x-robots-tag"), name).toBe("noindex");
      }
      expect(on, name).toContain('class="r-dev"');
      expect(on, name).toContain("--k-accent:#3355cc");
      expect(off, name).not.toContain("r-dev");
      expect(off, name).not.toContain("--k-accent");
      expect(off, name).not.toContain("/dashboard");
    }
  });

  // A client that sends neither an HTML accept nor a form body gets a word, not a page.
  // (A mail client's RFC 8058 one-click POST is form-encoded, so it gets the page, which
  // it never shows.)
  it("a bare unsubscribe POST, asking for no page, answers plain text", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?token=uns-a`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unsubscribed");
  });
});
