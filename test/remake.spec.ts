import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import worker from "../src/index";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import { adminAuth } from "./support/auth";

// A template or identity change re-makes every scheduled send at once, after the
// client acknowledges them (SPEC §6, §9). One test per rule.

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

/** A valid template whose footer carries `marker`, renders the name and the logo, and
 *  (optionally) the address, so a test can tell which branding a frozen copy is on. */
const tpl = (marker: string, withAddress = false) =>
  `<div>{{ post.body }}<p class="foot">${marker} · {{ publication.name }} · <img src="{{ email.unsubscribeUrl }}">${
    withAddress ? " · {{ publication.address }}" : ""
  }</p><a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

async function putSettings(patch: unknown): Promise<Response> {
  return SELF.fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: JSON_AUTH,
    body: JSON.stringify(patch),
  });
}

async function getSettings(): Promise<any> {
  return readJson(await SELF.fetch(`${base}/api/settings`, { headers: AUTH }));
}

async function makeDraft(subject: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject, markdown: `# ${subject}\n\nbody of ${subject}` }),
    }),
  );
  return created.post.id;
}

async function schedule(postId: string, msFromNow = 10 * 60 * 1000): Promise<any> {
  const res = await SELF.fetch(`${base}/posts/${postId}/schedule`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ fire_at: new Date(Date.now() + msFromNow).toISOString() }),
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).send;
}

async function sendNow(postId: string): Promise<any> {
  const res = await SELF.fetch(`${base}/posts/${postId}/send`, { method: "POST", headers: AUTH });
  expect(res.status).toBe(201);
  return (await readJson(res)).send;
}

/** The send's view, with its frozen email beside it (read at its own route). */
async function getSend(id: string): Promise<any> {
  const { send } = await readJson(await SELF.fetch(`${base}/sends/${id}`, { headers: AUTH }));
  const html = await (await SELF.fetch(`${base}/sends/${id}/email`, { headers: AUTH })).text();
  return { ...send, rendered_html: html };
}

async function cancel(id: string): Promise<void> {
  expect(
    (await SELF.fetch(`${base}/sends/${id}/cancel`, { method: "POST", headers: AUTH })).status,
  ).toBe(200);
}

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

// The rules are about "every scheduled send", so each test starts from none.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM subscribers"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clearFakeOutbox();
  expect((await putSettings({ emailTemplate: tpl("v1") })).status).toBe(200);
});

describe("a template or identity change re-makes the scheduled emails", () => {
  it("a template save with scheduled sends is refused (409 remake_required) listing them, and changes nothing", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const b = await schedule(await makeDraft("Post B"), 20 * 60 * 1000);

    const res = await putSettings({ emailTemplate: tpl("v2") });
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toBe("remake_required");
    expect(body.sends.map((s: any) => s.id)).toEqual([a.id, b.id]); // soonest first
    expect(body.sends[0]).toMatchObject({ post_id: a.post_id, subject: "Post A", remade_at: null });

    expect((await getSettings()).settings.emailTemplate).toBe(tpl("v1"));
    for (const id of [a.id, b.id]) {
      const s = await getSend(id);
      expect(s.rendered_html).toContain("v1");
      expect(s.remade_at).toBeNull();
    }
  });

  it("an acknowledged template save re-makes every scheduled send at once, keeps the window, and reports what was re-made", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const b = await schedule(await makeDraft("Post B"), 20 * 60 * 1000);

    const res = await putSettings({ emailTemplate: tpl("v2"), remake: [a.id, b.id] });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.remade.map((s: any) => s.id)).toEqual([a.id, b.id]);
    expect(body.remade[0].remade_at).toBeGreaterThan(0);

    for (const before of [a, b]) {
      const after = await getSend(before.id);
      expect(after.rendered_html).toContain("v2");
      expect(after.rendered_html).not.toContain("v1");
      expect(after.rendered_html).toContain(`body of ${before.subject}`); // the content is the locked content
      expect(after.status).toBe("scheduled");
      expect(after.fire_at).toBe(before.fire_at);
      expect(after.scheduled_at).toBe(before.scheduled_at);
      expect(after.audience.count).toBe(before.audience.count);
      expect(after.remade_at).toBe(body.remade[0].remade_at);
    }
    // The post read and the send list carry the mark.
    const post = await readJson(await SELF.fetch(`${base}/posts/${a.post_id}`, { headers: AUTH }));
    expect(post.scheduled).toMatchObject({ id: a.id, remade_at: body.remade[0].remade_at });
    const list = await readJson(
      await SELF.fetch(`${base}/sends?status=scheduled`, { headers: AUTH }),
    );
    expect(list.sends.find((s: any) => s.id === a.id).remade_at).toBe(body.remade[0].remade_at);
  });

  it("an identity change the template renders re-makes the same way, and so do the logo upload and delete", async () => {
    const a = await schedule(await makeDraft("Post A"));

    const refused = await putSettings({ publication: { name: "Renamed" } });
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("remake_required");
    const ok = await putSettings({ publication: { name: "Renamed" }, remake: [a.id] });
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).remade.map((s: any) => s.id)).toEqual([a.id]);
    expect((await getSend(a.id)).rendered_html).toContain("Renamed");

    // The logo: the template renders it (an <img> of the logo url is not in tpl(), so
    // switch to one that does), then upload without and with the acknowledgement.
    const withLogo = `${tpl("v1")}<img src="{{ publication.logoUrl }}">`;
    expect((await putSettings({ emailTemplate: withLogo, remake: [a.id] })).status).toBe(200);
    const fd = () => {
      const f = new FormData();
      f.append("file", new File([PNG_1x1], "logo.png", { type: "image/png" }));
      return f;
    };
    const up = await SELF.fetch(`${base}/api/settings/logo`, {
      method: "POST",
      headers: AUTH,
      body: fd(),
    });
    expect(up.status).toBe(409);
    expect((await readJson(up)).error).toBe("remake_required");
    // A refused upload wrote no bytes.
    expect((await SELF.fetch(`${base}/media/branding/logo`)).status).toBe(404);

    const upOk = await SELF.fetch(`${base}/api/settings/logo?remake=${a.id}`, {
      method: "POST",
      headers: AUTH,
      body: fd(),
    });
    expect(upOk.status).toBe(200);
    const upBody = await readJson(upOk);
    expect(upBody.remade.map((s: any) => s.id)).toEqual([a.id]);
    expect((await getSend(a.id)).rendered_html).toContain("/media/branding/logo?v=");
    expect((await SELF.fetch(`${base}/media/branding/logo`)).status).toBe(200);

    const del = await SELF.fetch(`${base}/api/settings/logo`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(409);
    const delOk = await SELF.fetch(`${base}/api/settings/logo?remake=${a.id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(delOk.status).toBe(200);
    expect((await getSend(a.id)).rendered_html).not.toContain("/media/branding/logo?v=");
  });

  it("an identical save changes nothing and asks nothing", async () => {
    const a = await schedule(await makeDraft("Post A"));
    // The same template text again.
    const same = await putSettings({ emailTemplate: tpl("v1") });
    expect(same.status).toBe(200);
    expect((await readJson(same)).remade).toEqual([]);
    // A name equal to the From display name over a blank one resolves to the same
    // branding (the From address in the test config carries no display name, so the
    // resolved name is "" either way: an explicit "" is no change).
    const blank = await putSettings({ publication: { name: "" } });
    expect(blank.status).toBe(200);
    expect((await readJson(blank)).remade).toEqual([]);
    expect((await getSend(a.id)).remade_at).toBeNull();
  });

  it("a save that touches only test recipients or the confirmation email asks nothing even with scheduled sends", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const res = await putSettings({
      testRecipients: ["me@example.com"],
      confirmationEmail: { subject: "Confirm, please" },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).remade).toEqual([]);
    expect((await getSend(a.id)).remade_at).toBeNull();
    expect((await getSettings()).settings.testRecipients).toEqual(["me@example.com"]);
  });

  it("an identity field the template does not render re-makes nothing and asks nothing, even inside the lead", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const soon = await sendNow(await makeDraft("Correction")); // inside the lead for its whole window
    // tpl() does not render the address.
    const res = await putSettings({ publication: { address: "12 Marsh Lane" } });
    expect(res.status).toBe(200);
    expect((await readJson(res)).remade).toEqual([]);
    expect((await getSend(a.id)).rendered_html).not.toContain("12 Marsh Lane");
    expect((await getSettings()).settings.publication.address).toBe("12 Marsh Lane");
    expect((await getSettings()).inUse.identityFields).toEqual(["name"]);

    // Once the template renders the address, the same change asks.
    await cancel(soon.id);
    expect((await putSettings({ emailTemplate: tpl("v1", true), remake: [a.id] })).status).toBe(
      200,
    );
    expect((await getSettings()).inUse.identityFields).toEqual(["name", "address"]);
    const asks = await putSettings({ publication: { address: "13 Marsh Lane" } });
    expect(asks.status).toBe(409);
    expect((await readJson(asks)).error).toBe("remake_required");
  });

  it("a scheduled send's frozen text part carries the address exactly when its frozen HTML does, and follows a re-make (SPEC §9)", async () => {
    const text = async (id: string) =>
      (await SELF.fetch(`${base}/sends/${id}/email?format=text`, { headers: AUTH })).text();
    const a = await schedule(await makeDraft("Post A"));
    // tpl() does not render the address, so neither part carries it.
    expect((await putSettings({ publication: { address: "12 Marsh Lane" } })).status).toBe(200);
    expect(await text(a.id)).not.toContain("12 Marsh Lane");

    // Once the template renders it, the re-made copy carries it in both parts.
    expect((await putSettings({ emailTemplate: tpl("v1", true), remake: [a.id] })).status).toBe(
      200,
    );
    expect((await getSend(a.id)).rendered_html).toContain("12 Marsh Lane");
    expect(await text(a.id)).toMatch(/\n12 Marsh Lane\n$/);

    // An address change re-makes the text part too, never leaving the old address behind.
    expect(
      (await putSettings({ publication: { address: "13 Marsh Lane" }, remake: [a.id] })).status,
    ).toBe(200);
    const after = await text(a.id);
    expect(after).toMatch(/\n13 Marsh Lane\n$/);
    expect(after).not.toContain("12 Marsh Lane");
  });

  it("is refused while any scheduled send is inside the minimum lead (409 remake_too_close), even when acknowledged, with retry_after; nothing changes", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const soon = await sendNow(await makeDraft("Correction"));

    const res = await putSettings({ emailTemplate: tpl("v2"), remake: [a.id, soon.id] });
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toBe("remake_too_close");
    expect(body.retry_after).toBe(soon.fire_at);
    expect(body.sends.map((s: any) => s.id)).toEqual([soon.id]);
    expect(body.message).toMatch(/Correction/);
    expect((await getSettings()).settings.emailTemplate).toBe(tpl("v1"));
    expect((await getSend(a.id)).rendered_html).toContain("v1");
    expect((await getSettings()).inUse.retry_after).toBe(soon.fire_at);

    // Once the send inside the lead is gone, the same save goes through.
    await cancel(soon.id);
    const ok = await putSettings({ emailTemplate: tpl("v2"), remake: [a.id] });
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).remade.map((s: any) => s.id)).toEqual([a.id]);
  });

  it("never touches a send that is sending, sent, or canceled", async () => {
    await seedConfirmed("reader@example.com");
    const sent = await schedule(await makeDraft("Sent post"));
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, sent.id)
      .run();
    await sweep(env);
    expect((await getSend(sent.id)).status).toBe("sent");
    const canceled = await schedule(await makeDraft("Canceled post"));
    await cancel(canceled.id);
    // A send in flight: past the window, so neither listed nor re-made.
    const sending = await schedule(await makeDraft("Sending post"));
    await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
      .bind(Date.now(), sending.id)
      .run();
    const kept = await schedule(await makeDraft("Kept post"));
    expect((await getSettings()).inUse.sends.map((s: any) => s.id)).toEqual([kept.id]);

    const res = await putSettings({ emailTemplate: tpl("v2"), remake: [kept.id] });
    expect(res.status).toBe(200);
    expect((await readJson(res)).remade.map((s: any) => s.id)).toEqual([kept.id]);
    for (const id of [sent.id, canceled.id, sending.id]) {
      const s = await getSend(id);
      expect(s.rendered_html).toContain("v1");
      expect(s.remade_at).toBeNull();
    }
    expect((await getSend(kept.id)).rendered_html).toContain("v2");
  });

  it("moving the fire time leaves the re-made copy and its mark alone (SPEC §6)", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const body = await readJson(await putSettings({ emailTemplate: tpl("v2"), remake: [a.id] }));
    const moved = await SELF.fetch(`${base}/sends/${a.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: new Date(Date.now() + 40 * 60 * 1000).toISOString() }),
    });
    expect(moved.status).toBe(200);
    const after = await getSend(a.id);
    expect(after.fire_at).not.toBe(a.fire_at);
    expect(after.rendered_html).toContain("v2");
    expect(after.remade_at).toBe(body.remade[0].remade_at);
  });

  it("an acknowledgement that omits a scheduled send is refused with the current list", async () => {
    const a = await schedule(await makeDraft("Post A"));
    const listed = (await getSettings()).inUse.sends.map((s: any) => s.id);
    expect(listed).toEqual([a.id]);
    const b = await schedule(await makeDraft("Post B")); // scheduled after the client looked

    const res = await putSettings({ emailTemplate: tpl("v2"), remake: listed });
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toBe("remake_required");
    expect(body.sends.map((s: any) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect((await getSettings()).settings.emailTemplate).toBe(tpl("v1"));
    expect((await getSend(a.id)).rendered_html).toContain("v1");
  });

  it("a schedule racing a template save never leaves the send on the older template", async () => {
    // Whichever order lands: either the save is refused (the send is on v1, the
    // template in use) or the save lands first (the send renders with v2). What can
    // never happen is a scheduled send on v1 under a saved v2.
    const postId = await makeDraft("Racer");
    const [sched, save] = await Promise.all([
      SELF.fetch(`${base}/posts/${postId}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 600_000).toISOString() }),
      }),
      putSettings({ emailTemplate: tpl("v2"), remake: [] }),
    ]);
    expect(sched.status).toBe(201);
    const send = await getSend((await readJson(sched)).send.id);
    const inUse = (await getSettings()).settings.emailTemplate;
    const marker = inUse === tpl("v2") ? "v2" : "v1";
    expect([200, 409]).toContain(save.status);
    expect(send.rendered_html).toContain(marker);
  });

  it("a re-made send fires with the re-made copy", async () => {
    await seedConfirmed("reader@example.com");
    const a = await schedule(await makeDraft("Post A"));
    expect((await putSettings({ emailTemplate: tpl("v2"), remake: [a.id] })).status).toBe(200);
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, a.id)
      .run();
    await sweep(env);
    const msg = fakeOutbox().find((m) => m.to === "reader@example.com");
    expect(msg).toBeTruthy();
    expect(msg!.html).toContain("v2");
    expect(msg!.html).not.toContain("v1");
    expect(msg!.html).toContain("/unsubscribe?token=uns-reader@example.com");
  });

  it("GET /api/settings reports inUse: the scheduled sends only, soonest first, retry_after when one is inside the lead, and the identity fields the template renders", async () => {
    await seedConfirmed("reader@example.com");
    const later = await schedule(await makeDraft("Later"), 60 * 60 * 1000);
    const sooner = await schedule(await makeDraft("Sooner"), 20 * 60 * 1000);
    const sent = await schedule(await makeDraft("Sent"));
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, sent.id)
      .run();
    await sweep(env);
    const canceled = await schedule(await makeDraft("Canceled"));
    await cancel(canceled.id);

    let inUse = (await getSettings()).inUse;
    expect(inUse.sends.map((s: any) => s.id)).toEqual([sooner.id, later.id]);
    expect(inUse.retry_after).toBeNull();
    expect(inUse.identityFields).toEqual(["name"]);

    const now = await sendNow(await makeDraft("Now"));
    inUse = (await getSettings()).inUse;
    expect(inUse.sends.map((s: any) => s.id)).toEqual([now.id, sooner.id, later.id]);
    expect(inUse.retry_after).toBe(now.fire_at);
  });

  it("the built-in template renders the logo, name, tagline, and address", async () => {
    await env.DB.prepare("DELETE FROM settings").run();
    expect((await getSettings()).inUse.identityFields).toEqual([
      "name",
      "tagline",
      "logoUrl",
      "address",
    ]);
  });

  it("refuses a malformed acknowledgement (400) before anything else", async () => {
    await schedule(await makeDraft("Post A"));
    const res = await putSettings({ emailTemplate: tpl("v2"), remake: "yes" });
    expect(res.status).toBe(400);
  });

  it("the settings-version guard refuses no acknowledged save by itself: two acknowledged saves in a row both land", async () => {
    const a = await schedule(await makeDraft("Post A"));
    expect((await putSettings({ emailTemplate: tpl("v2"), remake: [a.id] })).status).toBe(200);
    expect((await putSettings({ emailTemplate: tpl("v3"), remake: [a.id] })).status).toBe(200);
    expect((await getSend(a.id)).rendered_html).toContain("v3");
  });

  it("the lead that refuses a re-make is the deployment's own (SPEC §6)", async () => {
    // Three minutes out: inside the default five-minute lead, outside a one-minute one. The
    // suite runs on the default, so the send is moved there directly.
    const a = await schedule(await makeDraft("Post A"));
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() + 3 * 60 * 1000, a.id)
      .run();
    const save = async (vars: Record<string, string>) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${base}/api/settings`, {
          method: "PUT",
          headers: JSON_AUTH,
          body: JSON.stringify({ emailTemplate: tpl("v2"), remake: [a.id] }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        { ...env, ...vars } as unknown as AppEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    const refused = await save({});
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("remake_too_close");
    const landed = await save({ MIN_LEAD_SECONDS: "60" });
    expect(landed.status).toBe(200);
    expect((await readJson(landed)).remade.map((s: any) => s.id)).toEqual([a.id]);
    expect((await getSend(a.id)).rendered_html).toContain("v2");
  });
});
