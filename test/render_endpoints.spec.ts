import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateTestResponse } from "../shared/settings";
import { FakeProvider } from "../src/providers/fake";
import { SENTTO_SENTINEL, UNSUB_SENTINEL } from "../src/render/template_engine";
import { sweep } from "../src/send/sweep";
import { AUTH, base, JSON_AUTH, PNG_1x1, readJson } from "./support/http";

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
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(Date.now(), scheduled.send.id)
      .run();
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

  it("400s when there are no recipients and no defaults", async () => {
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
  });

  it("400s on an invalid address", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "not-an-email" }),
    });
    expect(res.status).toBe(400);
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
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, scheduled.send.id)
      .run();
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
