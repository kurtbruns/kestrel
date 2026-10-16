import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestSendResponse } from "../shared/posts";
import { refusalAdvice } from "../shared/sends";
import type { TemplateTestResponse } from "../shared/settings";
import { FakeProvider } from "../src/providers/fake";
import type { Recipient, SendBatchResult } from "../src/providers/types";
import { SENTTO_SENTINEL, UNSUB_SENTINEL } from "../src/render/template_engine";
import { sweep } from "../src/send/sweep";
import { setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, PNG_1x1, readJson } from "./support/http";
import { logged } from "./support/log";

async function draftWithImage(title: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: `Subject: ${title}`, markdown: "# Hi\n\n![A cat](cat.png)" }),
    }),
  );
  const id = created.post.id;
  const fd = new FormData();
  fd.append("file", new File([PNG_1x1], "cat.png", { type: "image/png" }));
  const upload = await SELF.fetch(`${base}/api/posts/${id}/images`, {
    method: "POST",
    headers: AUTH,
    body: fd,
  });
  // Every caller asserts on the image's rewritten URL, so a failed upload must stop here.
  expect(upload.status).toBe(201);
  return id;
}

describe("preview + test endpoints", () => {
  it("POST /preview returns a hosted view-in-browser URL", async () => {
    const id = await draftWithImage("Preview One");
    const res = await SELF.fetch(`${base}/api/posts/${id}/preview`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.url).toBe(`http://localhost:8787/api/posts/${id}/preview`);
    expect(body.subject).toBe("Subject: Preview One");
  });

  it("GET /preview serves rendered HTML with the sentinel substituted", async () => {
    const id = await draftWithImage("Preview Two");
    const res = await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`/media/posts/${id}/cat.png`);
    expect(html).not.toContain(UNSUB_SENTINEL);
    // The preview's link is a test's, so following it unsubscribes no one (SPEC §7).
    expect(html).toContain("/unsubscribe?test=1");
  });

  it("GET /preview requires auth", async () => {
    const id = await draftWithImage("Preview Auth");
    const res = await SELF.fetch(`${base}/api/posts/${id}/preview`);
    expect(res.status).toBe(401);
  });

  it("POST /test sends the real render through the provider (same render path, I5)", async () => {
    const id = await draftWithImage("Test Send");
    const to = `probe-${id}@example.com`;
    const res = await SELF.fetch(`${base}/api/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(true);
    expect(body.provider).toBe("fake");

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const msg = outbox.messages.find((m: any) => m.to === to);
    expect(msg).toBeTruthy();
    expect(msg.subject).toBe("Subject: Test Send");
    // Same render path as preview: resolved image URL present, sentinel substituted.
    expect(msg.html).toContain(`/media/posts/${id}/cat.png`);
    expect(msg.html).not.toContain(UNSUB_SENTINEL);
    expect(msg.html).toContain("/unsubscribe?test=1");
  });

  it("POST /test sends again on every press, including after an edit (each test has its own key)", async () => {
    const id = await draftWithImage("Test Twice");
    const to = `twice-${id}@example.com`;
    const test = () =>
      SELF.fetch(`${base}/api/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to }),
      });
    expect((await test()).status).toBe(200);
    // The same test again: the fake records once per key, so a reused key would fold it into nothing.
    expect((await test()).status).toBe(200);
    // An edited post: a fresh key again.
    const { post } = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    const edit = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({
        subject: "Subject: Test Twice, edited",
        base_revision: post.current_revision,
      }),
    });
    expect(edit.status).toBe(200);
    expect((await test()).status).toBe(200);

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const subjects = outbox.messages.filter((m: any) => m.to === to).map((m: any) => m.subject);
    expect(subjects).toEqual([
      "Subject: Test Twice",
      "Subject: Test Twice",
      "Subject: Test Twice, edited",
    ]);
  });

  it("a scheduled post's test and preview are its frozen copy, not a live render (SPEC §5)", async () => {
    // Once the re-make rule holds, the frozen copy differs from a live render only by
    // a direct edit of the send's bytes, which is exactly what makes this test honest:
    // the instruments must read the send, whatever it holds.
    const id = await draftWithImage("Frozen");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 600_000).toISOString() }),
      }),
    );
    const sentinel = `FROZEN-${crypto.randomUUID()}`;
    await env.DB.prepare("UPDATE sends SET rendered_html = ?, rendered_text = ? WHERE id = ?")
      .bind(
        `<p>${sentinel}</p><a href="${UNSUB_SENTINEL}">u</a>`,
        `${sentinel}\nUnsubscribe: ${UNSUB_SENTINEL}`,
        scheduled.send.id,
      )
      .run();

    const to = `frozen-${id}@example.com`;
    const test = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to }),
      }),
    );
    expect(test.frozen).toBe(true);
    const msg = (
      await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }))
    ).messages.find((m: any) => m.to === to);
    expect(msg.html).toContain(sentinel);
    expect(msg.html).toContain("/unsubscribe?test=1"); // the placeholders are filled as at fire
    expect(msg.html).not.toContain(UNSUB_SENTINEL);

    const page = await (
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(page).toContain(sentinel);
    expect(page).toContain("/unsubscribe?test=1");
    expect(page).not.toContain(UNSUB_SENTINEL);
    const action = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { method: "POST", headers: AUTH }),
    );
    expect(action.frozen).toBe(true);

    // A post whose send is in flight is still the frozen copy (the post stays
    // `scheduled` while its send is `sending`).
    await setRow(scheduled.send.id, { status: "sending", started_at: Date.now() });
    const inFlight = await (
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(inFlight).toContain(sentinel);

    // Once sent, the record's copy: the same bytes the archive page serves (I3).
    await env.DB.batch([
      env.DB.prepare("UPDATE sends SET status = 'sent', completed_at = ? WHERE id = ?").bind(
        Date.now(),
        scheduled.send.id,
      ),
      env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(id),
    ]);
    const sentPage = await (
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(sentPage).toContain(sentinel);
    const sentTest = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to: `sent-${to}` }),
      }),
    );
    expect(sentTest.frozen).toBe(true);
    const post = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    const slug = post.post.slug;
    const archive = await (await SELF.fetch(`${base}/archive/${slug}`)).text();
    expect(archive).toContain(sentinel);
  });

  it("a draft's test and preview are a live render (frozen: false)", async () => {
    const id = await draftWithImage("Live");
    const action = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { method: "POST", headers: AUTH }),
    );
    expect(action.frozen).toBe(false);
    const test = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ to: `live-${id}@example.com` }),
      }),
    );
    expect(test.frozen).toBe(false);
  });

  it("POST /test rejects a missing/invalid address (400)", async () => {
    const id = await draftWithImage("Bad Address");
    const res = await SELF.fetch(`${base}/api/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "bad_request",
      message: "“not-an-email” isn’t a valid email address. Fix it, then send again.",
      field: "to",
    });
  });
});

describe("template test-send (POST /api/settings/template/test)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires auth", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "you@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("renders a sample post through the one render path and delivers it (I5)", async () => {
    const to = "template-probe@example.com";
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(1);
    expect(body.total).toBe(1);
    expect(body.provider).toBe("fake");

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const msg = outbox.messages.find((m: any) => m.to === to);
    expect(msg).toBeTruthy();
    // The sample body flows through the same render as a real send: sentinel
    // substituted, the test unsubscribe link present.
    expect(msg.html).not.toContain(UNSUB_SENTINEL);
    expect(msg.html).toContain("/unsubscribe?test=1");
    // The sample subject line proves it rendered the synthetic post.
    expect(msg.subject).toContain("Template test");
  });

  it("accepts several addresses in one call", async () => {
    const tos = ["multi-a@example.com", "multi-b@example.com"];
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: tos }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.sent).toBe(2);
    expect(body.total).toBe(2);
  });

  it("names the addresses the provider didn't take, so a retry mails only those", async () => {
    const tos = ["partial-a@example.com", "partial-b@example.com", "partial-c@example.com"];
    const real = FakeProvider.prototype.sendBatch;
    vi.spyOn(FakeProvider.prototype, "sendBatch").mockImplementation(async function (
      this: FakeProvider,
      rendered,
      recipients,
      opts,
    ) {
      const answer = await real.call(this, rendered, recipients, opts);
      if (answer.kind !== "answered") {
        return answer;
      }
      // The provider refuses the middle address and takes the rest.
      const results = answer.results.map((r) =>
        r.email === "partial-b@example.com"
          ? { email: r.email, accepted: false as const, retryable: false, error: "refused" }
          : r,
      );
      return { kind: "answered", results };
    });
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: tos }),
    });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as TemplateTestResponse;
    expect(body.sent).toBe(2);
    expect(body.total).toBe(3);
    expect(body.failed).toEqual(["partial-b@example.com"]);
  });

  it("answers an empty failed list when every address was sent", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "all-sent@example.com" }),
    });
    expect(((await readJson(res)) as TemplateTestResponse).failed).toEqual([]);
  });

  it("falls back to the saved default recipients when `to` is omitted", async () => {
    const dflt = "default-inbox@example.com";
    const put = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ testRecipients: [dflt] }),
    });
    expect(put.status).toBe(200);

    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.recipients).toEqual([dflt]);
    expect(body.sent).toBe(1);
  });

  it("400s on `to` when there are no recipients and no defaults, saying where to add them", async () => {
    // Clear any default recipients a prior test set.
    await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ testRecipients: [] }),
    });
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "bad_request",
      message:
        "There’s no one to send the test to. Enter an address, or set default test recipients in Settings.",
      field: "to",
    });
  });

  it("400s on `to` for more addresses than one test goes to", async () => {
    const to = Array.from({ length: 21 }, (_, i) => `many-${i}@example.com`);
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "bad_request",
      message: "A test can go to at most 20 addresses. Remove some, then send again.",
      field: "to",
    });
  });

  it("400s on an invalid address", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "bad_request",
      message: "“not-an-email” isn’t a valid email address. Fix or remove it.",
      field: "to",
    });
  });
});

describe("web version (GET /api/posts/:id/web)", () => {
  // A post page in the dev-shaped test env adds only the dev-only pill and its styles;
  // strip both and what is left must be the web version, byte for byte.
  const withoutPill = (html: string) =>
    html
      .replace(/<a class="r-dev"[\s\S]*?<\/a>/, "")
      .replace(/<style>[^<]*\.r-dev[\s\S]*?<\/style>/, "");

  it("requires auth", async () => {
    const id = await draftWithImage("Web Auth");
    expect((await SELF.fetch(`${base}/api/posts/${id}/web`)).status).toBe(401);
  });

  it("shows a draft the way its post page will: masthead and web font in, email-only parts out", async () => {
    const id = await draftWithImage("Web Draft");
    const res = await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
    const html = await res.text();
    expect(html).toContain(">Hi</h1>");
    expect(html).toContain(`/media/posts/${id}/cat.png`);
    expect(html).toContain('class="k-mast"');
    expect(html).toContain("fonts.googleapis.com/css2?family=Fraunces");
    // The template's email-only footer is left out, as on the post page.
    expect(html).not.toContain(">Unsubscribe</a>");
    expect(html).not.toContain(">View in browser</a>");
    expect(html).toContain("Powered by Kestrel");
    for (const s of [UNSUB_SENTINEL, SENTTO_SENTINEL]) {
      expect(html).not.toContain(s);
    }
    // A publisher's look, not a reader page: no dev-only dashboard pill.
    expect(html).not.toContain('class="r-dev"');
  });

  it("is the post page itself once the send starts, apart from the dev-only pill", async () => {
    const id = await draftWithImage("Web Sent");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('web','web@example.com','confirmed','cfm-web','uns-web',?,?)",
    )
      .bind(Date.now(), Date.now())
      .run();

    try {
      const scheduled = await readJson(
        await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ fire_at: new Date(Date.now() + 600_000).toISOString() }),
        }),
      );
      // Scheduled: the frozen copy, as its page will show it.
      const before = await (
        await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH })
      ).text();
      expect(before).toContain('class="k-mast"');

      await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
        .bind(Date.now() - 1000, scheduled.send.id)
        .run();
      await sweep(env);
      const slug = (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH })))
        .post.slug;
      const web = await (await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH })).text();
      const archive = await (await SELF.fetch(`${base}/archive/${slug}`)).text();
      // The post page adds only the dev-only pill (the test env is dev-shaped).
      expect(archive).toContain('class="r-dev"');
      expect(withoutPill(archive)).toBe(web);
    } finally {
      await env.DB.prepare("DELETE FROM deliveries WHERE email = 'web@example.com'").run();
      await env.DB.prepare("DELETE FROM subscribers WHERE id = 'web'").run();
    }
  });

  it("serves the frozen copy while the send is going out, the same page its readers already reach", async () => {
    const id = await draftWithImage("Web Sending");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 600_000).toISOString() }),
      }),
    );
    // The send has started and is still going out.
    await setRow(scheduled.send.id, { status: "sending", started_at: Date.now() - 1000 });
    // Mark the frozen copy, so a page built from anything else (a fresh render) shows.
    await env.DB.prepare(
      "UPDATE sends SET rendered_html = replace(rendered_html, '>Hi</h1>', '>Frozen</h1>') WHERE id = ?",
    )
      .bind(scheduled.send.id)
      .run();
    const slug = (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH })))
      .post.slug;
    const res = await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH });
    expect(res.status).toBe(200);
    const web = await res.text();
    expect(web).toContain(">Frozen</h1>");
    const archive = await (await SELF.fetch(`${base}/archive/${slug}`)).text();
    expect(withoutPill(archive)).toBe(web);
  });

  it("404s for an unknown post", async () => {
    expect((await SELF.fetch(`${base}/api/posts/nope/web`, { headers: AUTH })).status).toBe(404);
  });
});

describe("a test that isn't sent says why (SPEC §5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The provider's answer to every test, in place of the fake's acceptance. */
  function answerTests(answer: (recipients: Recipient[]) => Promise<SendBatchResult>) {
    vi.spyOn(FakeProvider.prototype, "sendBatch").mockImplementation((_rendered, recipients) =>
      answer(recipients),
    );
  }

  async function postTest(to: string): Promise<{ status: number; body: TestSendResponse }> {
    const created = await readJson(
      await SELF.fetch(`${base}/api/posts`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ subject: "Owls", markdown: "Hoot." }),
      }),
    );
    const res = await SELF.fetch(`${base}/api/posts/${created.post.id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    return { status: res.status, body: (await readJson(res)) as TestSendResponse };
  }

  // A rejection that is the address's own: SES refuses the message for that recipient. (A
  // sandbox account's refusal of an unverified address is the account's, a halt, below.)
  const rejectedWords = (to: string) => `ses MESSAGE_REJECTED: Illegal address: ${to}`;

  it("a refused post test carries the provider's words, and says resending gets the same answer", async () => {
    const warn = vi.spyOn(console, "warn");
    answerTests(async (recipients) => ({
      kind: "answered",
      results: recipients.map((r) => ({
        email: r.email,
        accepted: false,
        retryable: false,
        error: rejectedWords(r.email),
      })),
    }));
    const { status, body } = await postTest("unverified@example.com");
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.not_sent).toEqual({
      may_have_arrived: false,
      error: rejectedWords("unverified@example.com"),
      message: `The provider refused it: ${rejectedWords("unverified@example.com")}. Sending to this address again gets the same answer until what the provider names is fixed.`,
    });
    // Logged without the address: SES's words keep only its domain (SPEC §12).
    const lines = logged(warn).filter((l) => l.event === "test.refused");
    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", provider: "fake", test: "post", count: 1 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("unverified@");
  });

  it("a post test the provider refuses for the account says the fix (the same advice as a send's refusal)", async () => {
    answerTests(async () => ({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "sender",
        error: "ses 400 MailFromDomainNotVerifiedException",
      },
    }));
    const { body } = await postTest("me@example.com");
    expect(body.sent).toBe(false);
    expect(body.not_sent).toEqual({
      may_have_arrived: false,
      error: "ses 400 MailFromDomainNotVerifiedException",
      message: `The provider refused it: ses 400 MailFromDomainNotVerifiedException. ${refusalAdvice("sender")} Sending the test again gets the same answer until that is fixed.`,
    });
  });

  it("a post test the SES sandbox refuses says to request production access, not to send again (SPEC §12)", async () => {
    const words =
      "ses 400 MessageRejected: Email address is not verified. The following identities failed the check in region US-EAST-1: unverified@example.com";
    answerTests(async () => ({
      kind: "halted",
      halt: { reason: "account", cause: "sandbox", error: words },
    }));
    const { body } = await postTest("unverified@example.com");
    expect(body.sent).toBe(false);
    expect(body.not_sent).toEqual({
      may_have_arrived: false,
      error: words,
      message: `The provider refused it: ${words}. ${refusalAdvice("sandbox")} Sending the test again gets the same answer until that is fixed.`,
    });
  });

  it("a post test the provider can't take right now says to send it again shortly", async () => {
    answerTests(async () => ({
      kind: "halted",
      halt: {
        reason: "unavailable",
        cause: "rate_limit",
        error: "ses 429 TooManyRequestsException",
      },
    }));
    const { body } = await postTest("me@example.com");
    expect(body.not_sent?.message).toBe(
      "The provider can’t take mail right now: ses 429 TooManyRequestsException. Send the test again in a few minutes.",
    );
  });

  it("a post test the provider never answers may have arrived, and is never a server error", async () => {
    const warn = vi.spyOn(console, "warn");
    answerTests(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const { status, body } = await postTest("me@example.com");
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.not_sent).toEqual({
      may_have_arrived: true,
      error: "The operation was aborted due to timeout",
      message:
        "The provider didn’t answer, so the test may have arrived: The operation was aborted due to timeout. Check the inbox before sending it again.",
    });
    expect(logged(warn).filter((l) => l.event === "test.unknown")).toEqual([
      expect.objectContaining({ level: "warn", provider: "fake", test: "post", count: 1 }),
    ]);
  });

  it("a sent post test carries no reason", async () => {
    const { body } = await postTest("me@example.com");
    expect(body.sent).toBe(true);
    expect(body.not_sent).toBeNull();
  });

  it("a template test says why for each address it missed, keeping a later one's 'may have arrived'", async () => {
    const warn = vi.spyOn(console, "warn");
    answerTests(async ([a, b, c]) => ({
      kind: "answered",
      results: [
        { email: a!.email, accepted: false, retryable: false, error: rejectedWords(a!.email) },
        {
          email: b!.email,
          accepted: false,
          retryable: false,
          error: "ses gave no answer (timeout)",
          unknown: true,
        },
        {
          email: c!.email,
          accepted: false,
          retryable: true,
          error: "not tried, since an earlier request got no answer",
        },
      ],
    }));
    const tos = ["first@example.com", "second@example.com", "third@example.com"];
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: tos }),
    });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as TemplateTestResponse;
    expect(body.sent).toBe(0);
    expect(body.failed).toEqual(tos);
    expect(body.not_sent).toEqual([
      {
        email: "first@example.com",
        may_have_arrived: false,
        error: rejectedWords("first@example.com"),
        message: `The provider refused it: ${rejectedWords("first@example.com")}. Sending to this address again gets the same answer until what the provider names is fixed.`,
      },
      {
        email: "second@example.com",
        may_have_arrived: true,
        error: "ses gave no answer (timeout)",
        message:
          "The provider didn’t answer, so the test may have arrived: ses gave no answer (timeout). Check the inbox before sending it again.",
      },
      {
        email: "third@example.com",
        may_have_arrived: false,
        error: "not tried, since an earlier request got no answer",
        message:
          "It wasn’t sent: not tried, since an earlier request got no answer. Send the test again to try it.",
      },
    ]);
    const lines = logged(warn).filter((l) => l.event.startsWith("test."));
    expect(lines.map((l) => [l.event, l.test, l.count])).toEqual([
      ["test.unknown", "template", 1],
      ["test.refused", "template", 1],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/first@|second@|third@/);
  });

  it("a template test refused for the account gives each address the refusal's advice", async () => {
    answerTests(async () => ({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "credentials",
        error: "ses 403 UnrecognizedClientException",
      },
    }));
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: ["a@example.com", "b@example.com"] }),
    });
    const body = (await readJson(res)) as TemplateTestResponse;
    expect(body.not_sent.map((n) => n.message)).toEqual(
      Array(2).fill(
        `The provider refused it: ses 403 UnrecognizedClientException. ${refusalAdvice("credentials")} Sending the test again gets the same answer until that is fixed.`,
      ),
    );
  });
});
