import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);

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
  await SELF.fetch(`${base}/api/posts/${id}/images`, { method: "POST", headers: AUTH, body: fd });
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
    expect(html).not.toContain("%%UNSUBSCRIBE_URL%%");
    expect(html).toContain("/unsubscribe");
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
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");
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
    // The same test again: an idempotent provider would fold a reused key into nothing.
    expect((await test()).status).toBe(200);
    // An edited post: a reused key would be refused (Resend's 409 on a changed payload).
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
        `<p>${sentinel}</p><a href="%%UNSUBSCRIBE_URL%%">u</a>`,
        `${sentinel}\nUnsubscribe: %%UNSUBSCRIBE_URL%%`,
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
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");

    const page = await (
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(page).toContain(sentinel);
    expect(page).toContain("/unsubscribe");
    expect(page).not.toContain("%%UNSUBSCRIBE_URL%%");
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
    expect(msg.html).not.toContain("%%UNSUBSCRIBE_URL%%");
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

// A test's one difference from the list send: its view-in-browser link opens the
// web-version preview in the editor, since the public page exists only once the post is
// sent (SPEC §5, I5).
describe("view in browser: a test's link opens the web version, the list send's the archive", () => {
  const VIEW = "%%VIEW_IN_BROWSER_URL%%";
  const viewLink = (html: string): string | undefined =>
    /<a [^>]*href="([^"]+)"[^>]*>View in browser<\/a>/.exec(html)?.[1];
  const outboxTo = async (to: string): Promise<any> =>
    (await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }))).messages.find(
      (m: any) => m.to === to,
    );

  it("a draft's test links to its web version in the editor, in both parts", async () => {
    const id = await draftWithImage("Draft Link");
    const to = `draft-link-${id}@example.com`;
    await SELF.fetch(`${base}/api/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    const msg = await outboxTo(to);
    const web = `http://localhost:8787/dashboard/?web=post%2F${id}`;
    expect(viewLink(msg.html)).toBe(web);
    expect(msg.text).toContain(`View in browser: ${web}`);
    expect(msg.html).not.toContain(VIEW);
    expect(msg.html).not.toContain("/archive/");
  });

  it("a scheduled post's test sends the frozen copy with the web-version link, and the list send the archive's", async () => {
    const id = await draftWithImage("Scheduled Link");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('vib','vib@example.com','confirmed','cfm-vib','uns-vib',?,?)",
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
      const frozen = await env.DB.prepare("SELECT rendered_html FROM sends WHERE id = ?")
        .bind(scheduled.send.id)
        .first<{ rendered_html: string }>();
      expect(frozen!.rendered_html).toContain(VIEW);

      const to = `scheduled-link-${id}@example.com`;
      const test = await readJson(
        await SELF.fetch(`${base}/api/posts/${id}/test`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ to }),
        }),
      );
      expect(test.frozen).toBe(true);
      const testMsg = await outboxTo(to);
      expect(viewLink(testMsg.html)).toBe(`http://localhost:8787/dashboard/?web=post%2F${id}`);

      // The same frozen copy, fired: every subscriber's link is the post's public page, and
      // the test's copy differs from it only in that link and the per-recipient values.
      const slug = (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH })))
        .post.slug;
      await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
        .bind(Date.now() - 1000, scheduled.send.id)
        .run();
      const { sweep } = await import("../src/send/sweep");
      await sweep(env);
      const listMsg = await outboxTo("vib@example.com");
      const archive = `http://localhost:8787/archive/${slug}`;
      expect(viewLink(listMsg.html)).toBe(archive);
      expect(listMsg.text).toContain(`View in browser: ${archive}`);
      const normalize = (html: string, link: string, unsub: string) =>
        html.split(link).join("LINK").split(unsub).join("UNSUB");
      expect(
        normalize(
          testMsg.html,
          `http://localhost:8787/dashboard/?web=post%2F${id}`,
          "http://localhost:8787/unsubscribe?test=1",
        ),
      ).toBe(normalize(listMsg.html, archive, "http://localhost:8787/unsubscribe?token=uns-vib"));
    } finally {
      await env.DB.prepare("DELETE FROM deliveries WHERE email = 'vib@example.com'").run();
      await env.DB.prepare("DELETE FROM subscribers WHERE id = 'vib'").run();
    }
  });

  it("a template test links to the sample's web version in the editor", async () => {
    const to = "template-link@example.com";
    await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    const msg = await outboxTo(to);
    expect(viewLink(msg.html)).toBe("http://localhost:8787/dashboard/?web=template");
    expect(msg.text).toContain("View in browser: http://localhost:8787/dashboard/?web=template");
  });

  it("the email preview shows the link a reader gets: the post's public page", async () => {
    const id = await draftWithImage("Preview Link");
    const slug = (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH })))
      .post.slug;
    const page = await (
      await SELF.fetch(`${base}/api/posts/${id}/preview`, { headers: AUTH })
    ).text();
    expect(viewLink(page)).toBe(`http://localhost:8787/archive/${slug}`);
  });
});

describe("web version (GET /api/posts/:id/web, GET /api/settings/template/web)", () => {
  it("requires auth", async () => {
    const id = await draftWithImage("Web Auth");
    expect((await SELF.fetch(`${base}/api/posts/${id}/web`)).status).toBe(401);
    expect((await SELF.fetch(`${base}/api/settings/template/web`)).status).toBe(401);
  });

  it("shows a draft the way its archive page will: masthead and web font in, email-only parts out", async () => {
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
    // The template's email-only footer is left out, as on the archive page.
    expect(html).not.toContain(">Unsubscribe</a>");
    expect(html).not.toContain(">View in browser</a>");
    expect(html).toContain("Powered by Kestrel");
    for (const s of ["%%VIEW_IN_BROWSER_URL%%", "%%UNSUBSCRIBE_URL%%", "%%SENT_TO%%"]) {
      expect(html).not.toContain(s);
    }
    // A publisher's preview, not a reader page: no dev-only dashboard pill.
    expect(html).not.toContain('class="r-dev"');
  });

  it("matches the archive page once the post is sent", async () => {
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
      // Scheduled: the frozen copy, its masthead dated for the fire time.
      const before = await (
        await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH })
      ).text();
      expect(before).toContain('class="k-mast"');

      await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
        .bind(Date.now() - 1000, scheduled.send.id)
        .run();
      const { sweep } = await import("../src/send/sweep");
      await sweep(env);
      const slug = (await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH })))
        .post.slug;
      const web = await (await SELF.fetch(`${base}/api/posts/${id}/web`, { headers: AUTH })).text();
      const archive = await (await SELF.fetch(`${base}/archive/${slug}`)).text();
      // The archive page adds only the dev-only pill (the test env is dev-shaped).
      const withoutPill = (html: string) =>
        html
          .replace(/<a class="r-dev"[\s\S]*?<\/a>/, "")
          .replace(/<style>[^<]*\.r-dev[\s\S]*?<\/style>/, "");
      expect(withoutPill(archive)).toBe(web);
    } finally {
      await env.DB.prepare("DELETE FROM deliveries WHERE email = 'web@example.com'").run();
      await env.DB.prepare("DELETE FROM subscribers WHERE id = 'web'").run();
    }
  });

  it("shows the template's sample post as an archive page", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/web`, { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The starlings are back");
    expect(html).toContain('class="k-mast"');
    expect(html).not.toContain(">Unsubscribe</a>");
  });

  it("404s for an unknown post", async () => {
    expect((await SELF.fetch(`${base}/api/posts/nope/web`, { headers: AUTH })).status).toBe(404);
  });
});
