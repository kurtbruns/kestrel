import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as posts from "../src/db/posts";
import { getConfig } from "../src/env";
import { serverErrorPage, unavailablePage } from "../src/lib/page";
import { CONFIRM_LINK_TTL_MS } from "../src/lib/time";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { AUTH, base } from "./support/http";

// The response headers that keep post content from running script on the app's own
// origin, keep the pages from being framed, and keep admin responses out of caches.

/** The page carries the strict policy: no script, no framing, and its address never leaves
 *  the browser as a referrer (SPEC §5). */
function expectHardenedPage(res: Response): void {
  const csp = res.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]) {
    expect(csp).toContain(directive);
  }
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

async function sentPost(title: string, markdown: string): Promise<posts.PostRow> {
  const { post } = await posts.createPost(env.DB, { subject: title, markdown }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

describe("reader and preview pages", () => {
  it("serve a post page under the strict policy, whatever HTML the post carries", async () => {
    const post = await sentPost(
      "Hardened",
      '# Hi\n\n<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    );
    const res = await SELF.fetch(`${base}/archive/${post.slug}`);
    expect(res.status).toBe(200);
    expectHardenedPage(res);
    // The page's own needs are allowed: the display font and images from any origin.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).toContain("img-src * data:");
    // A form in the post's body can't submit: it would carry the publisher's session to
    // the admin API on this same origin.
    expect(csp).toContain("form-action 'none'");
  });

  it("serve the home page, the archive index, a not-found post, and the subscribe, confirm, and unsubscribe pages the same way", async () => {
    for (const path of [
      "/",
      "/archive",
      "/archive/no-such-post",
      "/subscribe",
      "/confirm?token=nope",
      "/unsubscribe?token=nope",
    ]) {
      const res = await SELF.fetch(`${base}${path}`, { headers: { accept: "text/html" } });
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expectHardenedPage(res);
      // The app's own forms (subscribe, confirm, unsubscribe) post back to it.
      expect(res.headers.get("content-security-policy"), path).toContain("form-action 'self'");
    }
  });

  it("serve the publisher's preview the same way, and never let it be stored", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Preview", markdown: "# Hi" }, "t");
    const res = await SELF.fetch(`${base}/api/posts/${post.id}/preview`, { headers: AUTH });
    expect(res.status).toBe(200);
    expectHardenedPage(res);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a page whose address holds a secret sends no referrer (SPEC §5, §12)", () => {
  const CONFIRM_TOKEN = "cfm-referrer-test";
  const UNSUB_TOKEN = "uns-referrer-test";
  const READER = "reader@example.com";

  /** A reader waiting on their confirmation, sent `age` ago, so each state of the confirm
   *  link can be reached from it. */
  async function seedPending(age = 0): Promise<void> {
    const sentAt = Date.now() - age;
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, confirm_sent_at, confirm_attempt_at, unsub_token, created_at) VALUES ('id-r', ?, 'pending', ?, ?, ?, ?, ?)",
    )
      .bind(READER, CONFIRM_TOKEN, sentAt, sentAt, UNSUB_TOKEN, sentAt)
      .run();
  }

  /** What a browser sends when it submits a form from a `no-referrer` page: its own request
   *  marked same-origin, an opaque `Origin`, and no `Referer`. */
  const FROM_THE_PAGE = {
    origin: "null",
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded",
  };

  function expectNoReferrer(res: Response, what: string, status: number): void {
    expect(res.status, what).toBe(status);
    expect(res.headers.get("content-type"), what).toContain("text/html");
    expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
  }

  const page = (path: string) =>
    SELF.fetch(`${base}${path}`, { headers: { accept: "text/html" }, redirect: "manual" });

  beforeEach(resetDatabase);

  it("on the confirm page, in each state a link can be in", async () => {
    await seedPending();
    expectNoReferrer(await page(`/confirm?token=${CONFIRM_TOKEN}`), "ready", 200);
    expectNoReferrer(await page("/confirm?token=no-such-token"), "invalid", 400);
    await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = ? WHERE email = ?")
      .bind(Date.now() - CONFIRM_LINK_TTL_MS - 1000, READER)
      .run();
    expectNoReferrer(await page(`/confirm?token=${CONFIRM_TOKEN}`), "expired", 410);
  });

  it("on the page a pressed Confirm answers, and the press needs no referrer", async () => {
    await seedPending();
    const res = await SELF.fetch(`${base}/confirm`, {
      method: "POST",
      headers: FROM_THE_PAGE,
      body: new URLSearchParams({ token: CONFIRM_TOKEN }),
    });
    expectNoReferrer(res, "confirmed", 200);
    const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email = ?")
      .bind(READER)
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");
    // The used link still opens, and still shows the address.
    expectNoReferrer(await page(`/confirm?token=${CONFIRM_TOKEN}`), "used", 200);
  });

  it("on each unsubscribe page, and the press needs no referrer", async () => {
    await seedConfirmed(READER);
    const token = `uns-${READER}`;
    const link = `/unsubscribe?token=${encodeURIComponent(token)}`;
    expectNoReferrer(await page(link), "ask", 200);
    expectNoReferrer(await page("/unsubscribe?token=no-such-token"), "invalid", 400);
    expectNoReferrer(await page("/unsubscribe?test=1"), "test", 200);
    // The address the button posts to holds the token, so the page it answers does too.
    const res = await SELF.fetch(`${base}${link}`, { method: "POST", headers: FROM_THE_PAGE });
    expectNoReferrer(res, "unsubscribed", 200);
    const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email = ?")
      .bind(READER)
      .first<{ status: string }>();
    expect(row?.status).toBe("unsubscribed");
    expectNoReferrer(await page(link), "already unsubscribed", 200);
  });

  it("leaves a mail client's one-click unsubscribe working, which no page sent", async () => {
    await seedConfirmed(READER);
    const res = await SELF.fetch(
      `${base}/unsubscribe?token=${encodeURIComponent(`uns-${READER}`)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM subscribers WHERE email = ?")
      .bind(READER)
      .first<{ status: string }>();
    expect(row?.status).toBe("unsubscribed");
  });

  it("leaves the expired page's request for a new link working, which posts to subscribe", async () => {
    await sendingWorks();
    await seedPending(CONFIRM_LINK_TTL_MS + 1000);
    const res = await SELF.fetch(`${base}/subscribe`, {
      method: "POST",
      headers: FROM_THE_PAGE,
      body: new URLSearchParams({ email: READER }),
    });
    expectNoReferrer(res, "check your inbox", 200);
  });

  it("on an unlisted link, before its post is sent and on an email-only post's page", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "Draft", markdown: "# Hi" }, "t");
    const link = `/email/${post.unlisted_token}`;
    expectNoReferrer(await page(link), "nothing here yet", 404);

    const sent = await sentPost("Email only", "# Hi");
    const current = await posts.getPost(env.DB, sent.id);
    expect(await posts.setPublishing(env.DB, current!, { emailOnly: true })).toBe("changed");
    expectNoReferrer(await page(`/email/${sent.unlisted_token}`), "email only", 200);
  });

  it("on the pages a failure answers at any of those addresses", () => {
    expect(serverErrorPage().headers.get("referrer-policy")).toBe("no-referrer");
    expect(unavailablePage().headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("admin responses", () => {
  it("are no-store: JSON, an error, and the gate's own 401", async () => {
    const ok = await SELF.fetch(`${base}/api/settings`, { headers: AUTH });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const missing = await SELF.fetch(`${base}/api/posts/no-such-post`, { headers: AUTH });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const denied = await SELF.fetch(`${base}/api/settings`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });

  it("leave a public response's caching as it was", async () => {
    const res = await SELF.fetch(`${base}/archive`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
