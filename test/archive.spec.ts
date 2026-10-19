import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { latestSentSendForPost } from "../src/db/sends";
import { newLogoKey, setPublicationLogo, updateSettings } from "../src/db/settings";
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
import { cancel, freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { dueSend, resetDatabase, seedConfirmed, setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH } from "./support/http";
import { fetchWith } from "./support/worker_env";

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

/** A post sent to one reader (`a@example.com`) through the sweep, as the archive serves it. */
async function sendPost(title: string, markdown: string): Promise<posts.PostRow> {
  await seedConfirmed("a@example.com");
  const send = await dueSend({ subject: title, markdown });
  await sweep(env);
  return (await posts.getPost(env.DB, send.post_id))!;
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
    // index (same origin as the post), not the app's home page.
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
    // Present first, then in order: indexOf's -1 for a missing piece would sort first.
    const style = body.indexOf(".r-dev {");
    const headEnd = body.indexOf("</head>");
    const mast = body.indexOf('class="k-mast"');
    const pill = body.indexOf('class="r-dev"');
    for (const at of [style, headEnd, mast, pill]) {
      expect(at).toBeGreaterThanOrEqual(0);
    }
    expect(style).toBeLessThan(headEnd);
    expect(mast).toBeLessThan(pill);
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
      expect(sent!.html).toContain("/unsubscribe?token=uns-a@example.com");
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
      email_template:
        '{{ .Post.Body }}<p class="foot"><a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></p>',
    });
    try {
      const post = await sendPost("No Region", "the post");
      const send = (await latestSentSendForPost(env.DB, post.id))!;
      expect(send.rendered_html).not.toContain(EMAIL_ONLY_OPEN);
      const body = await (await SELF.fetch(`${base}/archive/${post.slug}`)).text();
      expect(body).toContain('href="http://localhost:8787/unsubscribe"');
    } finally {
      await updateSettings(env.DB, { email_template: "" });
    }
  });

  // A test email's "view in browser" link lands here before the send starts. The page
  // must not tell a scheduled post's address from a draft's or a made-up one, or it would
  // reveal what is on its way.
  it("answers a draft, a scheduled post, a canceled post, and an unknown slug with the same page", async () => {
    await ensureSubscriber();
    const { post: draft } = await posts.createPost(
      env.DB,
      { subject: "Still a Draft", markdown: "wip" },
      "test",
    );
    const { post: scheduled } = await posts.createPost(
      env.DB,
      { subject: "Coming Soon", markdown: "soon" },
      "test",
    );
    await freeze(env, getConfig(env), scheduled, Date.now() + 3_600_000);
    const { post: canceled } = await posts.createPost(
      env.DB,
      { subject: "Called Off", markdown: "never mind" },
      "test",
    );
    const canceledSend = await freeze(env, getConfig(env), canceled, Date.now() + 3_600_000);
    await cancel(env, canceledSend.id);
    const pages = await Promise.all(
      [draft.slug, scheduled.slug, canceled.slug, "no-such-post"].map(async (slug) => {
        const res = await SELF.fetch(`${base}/archive/${slug}`);
        expect(res.status, slug).toBe(404);
        expect(res.headers.get("cache-control"), slug).toBe("no-store");
        expect(res.headers.get("x-robots-tag"), slug).toBe("noindex");
        return res.text();
      }),
    );
    expect(pages[0]).toContain("Nothing here yet");
    expect(pages[0]).toContain("A post appears here as soon as it’s sent.");
    expect(pages[0]).toContain("Browse the archive");
    expect(pages[0]).not.toContain("Still a Draft");
    expect(pages[1]).not.toContain("Coming Soon");
    expect(pages[2]).not.toContain("Called Off");
    expect(pages[1]).toBe(pages[0]);
    expect(pages[2]).toBe(pages[0]);
    expect(pages[3]).toBe(pages[0]);
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

describe("home page (the public front door, §5)", () => {
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

  it("serves a send still going out at its archive URL, in the index and on the home page, dated by its start", async () => {
    const { post, sendId } = await frozenPost("Going Out");
    await setRow(sendId, { status: "sending", started_at: JAN_5 });
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
    await setRow(sendId, { status: "sent", started_at: JAN_5, completed_at: JAN_7 });
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
    await cancel(env, canceled.sendId);
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

  it("home page omits the dashboard link when devDashboardUrl is unset", async () => {
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
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, unsubscribed_at, unsubscribe_cause) VALUES ('u','u@example.com','unsubscribed',NULL,'uns-u',?,?,'reader')",
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
      [
        "subscribe form",
        subscribeForm,
        "/subscribe",
        [`Subscribe to ${publication}`, "We’ll email you a link to confirm. Unsubscribe anytime."],
        200,
      ],
      [
        "subscribe (bad address)",
        subscribe,
        "/subscribe",
        ["doesn’t look like an email"],
        400,
        badForm,
      ],
      ["post not found", archivePage, "/archive/missing", ["Nothing here yet"], 404],
      [
        "test unsubscribe",
        unsubscribeLanding,
        "/unsubscribe?test=1",
        [`Unsubscribe from ${publication}?`, "reader@example.com", 'class="r-banner"'],
        200,
      ],
      [
        "test unsubscribe POST",
        unsubscribe,
        "/unsubscribe?test=1",
        ["You’re unsubscribed", "reader@example.com", 'class="r-banner"'],
        200,
        html,
      ],
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
      // The accent tokens come with the pill, or with a test page's strip, which wears the
      // same accent; a page with neither carries none.
      if (!off.includes('class="r-banner"')) {
        expect(off, name).not.toContain("--k-accent");
      }
      expect(off, name).not.toContain("/dashboard");
    }
  });
});

// A client that sends neither an HTML accept nor a form body gets a word, not a page.
// (A mail client's RFC 8058 one-click POST is form-encoded, so it gets the page, which
// it never shows.)
describe("an unsubscribe POST asking for no page", () => {
  it("answers plain text", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?token=uns-a`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unsubscribed");
  });
});

// A test email carries the list send's links, but it is not a list send, so its
// unsubscribe link carries no subscriber's token and has no one to unsubscribe.
describe("a test email's unsubscribe link", () => {
  const statusOf = async (id: string) =>
    (
      await env.DB.prepare("SELECT status FROM subscribers WHERE id = ?")
        .bind(id)
        .first<{ status: string }>()
    )?.status;

  const banner = "This is the page a subscriber sees. Nothing here changes anyone’s subscription.";

  it("opens the page a subscriber sees, marked as a test, and unsubscribes no one", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?test=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("Unsubscribe from ");
    expect(body).toContain("<strong>reader@example.com</strong>");
    expect(body).toContain('class="r-banner"');
    expect(body).toContain(banner);
    // The strip is the body's first child, outside the masthead, so the masthead beneath
    // is the one a reader gets.
    expect(body).toContain('<body>\n<div class="r-banner" role="note">');
    expect(body.indexOf('class="r-banner"')).toBeLessThan(body.indexOf('class="r-mast"'));
    // Its button posts back as a test, never with a token.
    expect(body).toContain('<form class="r-form" method="post" action="/unsubscribe?test=1">');
    expect(body).not.toContain("token=");
    expect(await statusOf("a")).toBe("confirmed");
  });

  it("walks through to the page a subscriber sees once unsubscribed, changing nothing", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?test=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("You’re unsubscribed");
    expect(body).toContain("<strong>reader@example.com</strong>");
    expect(body).toContain(banner);
    expect(await statusOf("a")).toBe("confirmed");
  });

  it("answers a mail client's one-click POST with a 200 and changes nothing", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?test=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    // RFC 8058's body is form-encoded, which reads as a person's form; a bare POST
    // answers plain text.
    expect(await res.text()).toContain(banner);
    const bare = await SELF.fetch(`${base}/unsubscribe?test=1`, { method: "POST" });
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe("test email");
    expect(await statusOf("a")).toBe("confirmed");
  });

  it("never stands in for a real token", async () => {
    await ensureSubscriber();
    const page = await (await SELF.fetch(`${base}/unsubscribe?token=uns-a&test=1`)).text();
    expect(page).toContain("Unsubscribe from ");
    expect(page).toContain('action="/unsubscribe?token=uns-a"');
    expect(page).not.toContain('class="r-banner"');
    const res = await SELF.fetch(`${base}/unsubscribe?token=uns-a&test=1`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("unsubscribed");
    expect(await statusOf("a")).toBe("unsubscribed");
    // A bad token with the marker is still a bad link, not a test.
    const badPage = await SELF.fetch(`${base}/unsubscribe?token=nope&test=1`);
    expect(badPage.status).toBe(400);
    expect(await badPage.text()).toContain("This link is invalid");
    const bad = await SELF.fetch(`${base}/unsubscribe?token=nope&test=1`, { method: "POST" });
    expect(bad.status).toBe(400);
  });

  it("lets a token in the form body win over the marker", async () => {
    await ensureSubscriber();
    const res = await SELF.fetch(`${base}/unsubscribe?test=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=uns-a",
    });
    expect(res.status).toBe(200);
    const done = await res.text();
    expect(done).toContain("You’re unsubscribed");
    expect(done).not.toContain('class="r-banner"');
    expect(await statusOf("a")).toBe("unsubscribed");
  });

  it("treats an empty token beside the marker as a test", async () => {
    await ensureSubscriber();
    const page = await SELF.fetch(`${base}/unsubscribe?token=&test=1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(banner);
    const post = await SELF.fetch(`${base}/unsubscribe?token=&test=1`, { method: "POST" });
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("test email");
    expect(await statusOf("a")).toBe("confirmed");
  });

  // The links a test email really carries, not ones written out here, so the link a
  // test builds and the pages it opens can't drift apart.
  it("opens the test pages from the links a sent test carries", async () => {
    await ensureSubscriber();
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Proof Copy", markdown: "proofing" },
      "test",
    );
    const res = await SELF.fetch(`${base}/api/posts/${post.id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "me@example.com" }),
    });
    expect(res.status).toBe(200);
    const sent = fakeOutbox().find((m) => m.to === "me@example.com")!;
    const hrefs = [...sent.html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!));
    const unsub = hrefs.find((u) => u.pathname === "/unsubscribe");
    const view = hrefs.find((u) => u.pathname === `/email/${post.unlisted_token}`);
    expect(unsub).toBeTruthy();
    expect(view).toBeTruthy();
    const unsubPath = `${unsub!.pathname}${unsub!.search}`;
    const unsubPage = await SELF.fetch(`${base}${unsubPath}`);
    expect(unsubPage.status).toBe(200);
    const unsubBody = await unsubPage.text();
    expect(unsubBody).toContain(banner);
    expect(unsubBody).toContain("<strong>reader@example.com</strong>");
    // The recipient's own address never appears: the link carries none.
    expect(unsubBody).not.toContain("me@example.com");
    const oneClick = await SELF.fetch(`${base}${unsubPath}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status).toBe(200);
    const viewPage = await SELF.fetch(`${base}${view!.pathname}`);
    expect(viewPage.status).toBe(404);
    expect(await viewPage.text()).toContain("Nothing here yet");
    expect(await statusOf("a")).toBe("confirmed");
  });

  // The preview is the same email shown to the publisher, so its link opens the same page.
  it("opens the same page from the link the editor's preview carries", async () => {
    await ensureSubscriber();
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Preview Copy", markdown: "proofing" },
      "test",
    );
    const res = await SELF.fetch(`${base}/api/posts/${post.id}/preview`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!));
    const unsub = hrefs.find((u) => u.pathname === "/unsubscribe");
    expect(unsub?.search).toBe("?test=1");
    const page = await SELF.fetch(`${base}${unsub!.pathname}${unsub!.search}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(banner);
    expect(await statusOf("a")).toBe("confirmed");
  });
});

// With no publication name and no display name on the sending address, every reader page
// words itself without a name rather than showing one the publisher didn't choose.
describe("a publication with no name (SPEC §9)", () => {
  const UNNAMED = { FROM_ADDRESS: "hello@send.example.com" };
  const NAMED = { FROM_ADDRESS: '"Birds Weekly" <hello@send.example.com>' };

  const titleOf = (page: string) => /<title>([^<]*)<\/title>/.exec(page)?.[1];
  const headlineOf = (page: string) => /<h1 class="r-h1">([^<]*)<\/h1>/.exec(page)?.[1];
  const mastheadOf = (page: string) =>
    /<header class="r-mast">[\s\S]*?<\/header>/.exec(page)?.[0] ?? "";

  /** The subscribers the pages need: a confirmed one (`uns-a`), a pending one with a live
   *  confirm link (`cfm-p`), one whose link lapsed (`cfm-x`), and one who left. */
  async function seedReaders(): Promise<void> {
    await ensureSubscriber();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirm_sent_at) VALUES ('p','p@example.com','pending','cfm-p','uns-p',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirm_sent_at) VALUES ('x','x@example.com','pending','cfm-x','uns-x',?,1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, unsubscribed_at, unsubscribe_cause) VALUES ('u','u@example.com','unsubscribed',NULL,'uns-u',?,?,'reader')",
      ).bind(now, now),
    ]);
  }

  const asForm = { accept: "text/html", "content-type": "application/x-www-form-urlencoded" };
  // Each row: the page, its path and request, and the title and headline it shows unnamed.
  const pages: [string, string, RequestInit, string, string][] = [
    ["subscribe form", "/subscribe", {}, "Subscribe", "Subscribe"],
    [
      "subscribe (bad address)",
      "/subscribe",
      { method: "POST", headers: asForm, body: "email=nope" },
      "Subscribe",
      "That doesn’t look like an email",
    ],
    [
      "subscribe (sent)",
      "/subscribe",
      { method: "POST", headers: asForm, body: "email=new@example.com" },
      "Subscribe",
      "Almost there",
    ],
    [
      "confirm (ready)",
      "/confirm?token=cfm-p",
      {},
      "Confirm your subscription",
      "Confirm your subscription",
    ],
    ["confirm (confirmed)", "/confirm?token=cfm-a", {}, "Subscribed", "You’re subscribed"],
    ["confirm (expired)", "/confirm?token=cfm-x", {}, "Link expired", "This link has expired"],
    ["confirm (invalid)", "/confirm?token=nope", {}, "Invalid link", "This link is invalid"],
    ["unsubscribe (ready)", "/unsubscribe?token=uns-a", {}, "Unsubscribe", "Unsubscribe?"],
    ["unsubscribe (test)", "/unsubscribe?test=1", {}, "Unsubscribe", "Unsubscribe?"],
    [
      "unsubscribe (already)",
      "/unsubscribe?token=uns-u",
      {},
      "Unsubscribed",
      "You’re unsubscribed",
    ],
    [
      "unsubscribe (invalid)",
      "/unsubscribe?token=nope",
      {},
      "Invalid link",
      "This link is invalid",
    ],
    [
      "unsubscribe POST (done)",
      "/unsubscribe?token=uns-p",
      { method: "POST", headers: asForm },
      "Unsubscribed",
      "You’re unsubscribed",
    ],
    ["post not found", "/archive/missing", {}, "Nothing here yet", "Nothing here yet"],
  ];

  it("words each subscribe, confirm, and unsubscribe page without a name, keeping a way home", async () => {
    await seedReaders();
    for (const [name, path, init, title, headline] of pages) {
      const page = await (await fetchWith(UNNAMED, path, init)).text();
      expect(titleOf(page), name).toBe(title);
      expect(headlineOf(page), name).toBe(headline);
      // With no name, logo, or tagline, the masthead still links home, labeled for where
      // it leads rather than with a made-up name.
      expect(mastheadOf(page), name).toBe(
        '<header class="r-mast"><div class="r-mast-in">\n' +
          '<a class="r-brand" href="http://localhost:8787/">Archive</a>\n\n' +
          "</div></header>",
      );
    }
  });

  it("names the publication on the same pages when the sender has a display name", async () => {
    await seedReaders();
    const named: [string, string, string][] = [
      ["/subscribe", "Subscribe · Birds Weekly", "Subscribe to Birds Weekly"],
      [
        "/confirm?token=cfm-p",
        "Confirm your subscription · Birds Weekly",
        "Confirm your subscription to Birds Weekly",
      ],
      ["/unsubscribe?token=uns-a", "Unsubscribe · Birds Weekly", "Unsubscribe from Birds Weekly?"],
      ["/confirm?token=cfm-a", "Subscribed · Birds Weekly", "You’re subscribed"],
    ];
    for (const [path, title, headline] of named) {
      const page = await (await fetchWith(NAMED, path)).text();
      expect(titleOf(page), path).toBe(title);
      expect(headlineOf(page), path).toBe(headline);
      expect(mastheadOf(page), path).toBe(
        '<header class="r-mast"><div class="r-mast-in">\n' +
          '<a class="r-brand" href="http://localhost:8787/"><span><span class="r-name">Birds Weekly</span></span></a>\n\n' +
          "</div></header>",
      );
    }
  });

  it("titles the home page and the archive index without a name", async () => {
    await publish("A Post", 1_000);
    for (const [path, title] of [
      ["/", "Home"],
      ["/archive", "Archive"],
    ] as const) {
      const page = await (await fetchWith(UNNAMED, path)).text();
      expect(titleOf(page), path).toBe(title);
      expect(mastheadOf(page), path).toBe(
        '<header class="r-mast"><div class="r-mast-in">\n' +
          '<a class="r-brand" href="http://localhost:8787/">Archive</a>\n' +
          '<span class="r-cta"><a class="r-sub" href="http://localhost:8787/subscribe">Subscribe here &rarr;</a></span>\n' +
          "</div></header>",
      );
      expect(page, path).not.toContain("Newsletter");
    }
  });

  it("titles the home page and the archive index by the name when there is one", async () => {
    await publish("A Post", 1_000);
    expect(titleOf(await (await fetchWith(NAMED, "/")).text())).toBe("Birds Weekly");
    expect(titleOf(await (await fetchWith(NAMED, "/archive")).text())).toBe(
      "Archive · Birds Weekly",
    );
  });

  it("links a logo alone home under an accessible name when there is no name", async () => {
    await setPublicationLogo(env.DB, { version: 1, contentType: "image/png" });
    const page = await (await fetchWith(UNNAMED, "/archive")).text();
    expect(mastheadOf(page)).toContain(
      '<a class="r-brand" href="http://localhost:8787/" aria-label="Home"><span class="r-logo">',
    );
    expect(page).not.toContain('class="r-name"');
  });

  it("points a post page's masthead back to the archive, by name when there is one (SPEC §5)", async () => {
    const post = await publish("A Post", 1_000);
    const backLink = (page: string) =>
      /<a href="http:\/\/localhost:8787\/archive"[^>]*>.*?&larr;<\/span>&nbsp;([^<]*)<\/a>/.exec(
        page,
      )?.[1];
    const unnamed = await (await fetchWith(UNNAMED, `/archive/${post.slug}`)).text();
    // Only the masthead is the page's own: the sign-off stays as it was sent (I3).
    expect(backLink(unnamed)).toBe("Archive");
    const named = await (await fetchWith(NAMED, `/archive/${post.slug}`)).text();
    expect(backLink(named)).toBe("Birds Weekly");
  });
});

describe("the publication logo as the tab icon (SPEC §5)", () => {
  const PAGES = ["/", "/archive", "/subscribe", "/archive/missing"];
  const iconsOf = (page: string) => page.match(/<link rel="icon"[^>]*>/g) ?? [];
  const headOf = (page: string) => /<head>[\s\S]*?<\/head>/.exec(page)?.[0] ?? "";

  it("links no icon while the publication has no logo", async () => {
    const post = await publish("A Post", 1_000);
    for (const path of [...PAGES, `/archive/${post.slug}`]) {
      const page = await (await SELF.fetch(`${base}${path}`)).text();
      expect(iconsOf(page), path).toEqual([]);
    }
  });

  it("links the current logo in every reader page's head, post pages included, never in the frozen or sent email (I3)", async () => {
    // A logo set before the send, so the render had one to leak if it ever carried the icon.
    await setPublicationLogo(env.DB, { version: 1, contentType: "image/png", key: newLogoKey(1) });
    const post = await publish("A Post", 1_000);
    const send = (await latestSentSendForPost(env.DB, post.id))!;
    for (const html of [send.rendered_html, fakeOutbox()[0]!.html]) {
      expect(html).not.toContain('rel="icon"');
    }

    // A new logo after the send: every page, the post page too, links the current one.
    const key = newLogoKey(2);
    await setPublicationLogo(env.DB, { version: 2, contentType: "image/png", key });
    const icon = `<link rel="icon" href="${getConfig(env).mediaPublicBase}/${key}">`;
    for (const path of [...PAGES, `/archive/${post.slug}`]) {
      const page = await (await SELF.fetch(`${base}${path}`)).text();
      expect(iconsOf(page), path).toEqual([icon]);
      expect(headOf(page), path).toContain(icon);
    }
  });
});
