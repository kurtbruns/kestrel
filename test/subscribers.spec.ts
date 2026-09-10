import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as subs from "../src/db/subscribers";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

let seq = 0;
const uniqueEmail = () => `person-${Date.now()}-${seq++}@example.com`;

async function publicSubscribe(email: string): Promise<Response> {
  return SELF.fetch(`${base}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

// The one-shot confirm token (rotated on re-arm) drives the /confirm link.
async function tokenFor(email: string): Promise<string> {
  const row = await subs.getByEmail(env.DB, email);
  return row!.confirm_token!;
}

// The durable unsubscribe token (never rotated) is what delivered mail embeds.
async function unsubTokenFor(email: string): Promise<string> {
  const row = await subs.getByEmail(env.DB, email);
  return row!.unsub_token;
}

describe("subscribers: double opt-in (I1) and unsubscribe (I2)", () => {
  it("public subscribe creates a pending subscriber and emails a confirmation", async () => {
    const email = uniqueEmail();
    const res = await publicSubscribe(email);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ status: "pending", action: "created" });

    const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
    const msg = outbox.messages.find((m: any) => m.to === email);
    expect(msg?.subject).toBe("Confirm your subscription");
  });

  it("only confirmed subscribers are in the audience (I1)", async () => {
    const pendingEmail = uniqueEmail();
    const confirmedEmail = uniqueEmail();
    await publicSubscribe(pendingEmail);
    await publicSubscribe(confirmedEmail);

    // confirm the second one
    const res = await SELF.fetch(`${base}/confirm?token=${await tokenFor(confirmedEmail)}`);
    expect(res.status).toBe(200);

    const audience = await subs.audienceEmails(env.DB);
    expect(audience).toContain(confirmedEmail);
    expect(audience).not.toContain(pendingEmail);
  });

  it("unsubscribe is immediate and final (I2), and re-subscribe requires re-confirmation", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // one-click unsubscribe via the durable unsub token (empty body, no html accept)
    const unsub = await SELF.fetch(`${base}/unsubscribe?token=${await unsubTokenFor(email)}`, {
      method: "POST",
    });
    expect(unsub.status).toBe(200);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // re-subscribe → pending again (NOT auto-confirmed)
    const re = await readJson(await publicSubscribe(email));
    expect(re).toMatchObject({ status: "pending", action: "resubscribed" });
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // confirm with the fresh confirm token → back in the audience
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });

  it("the unsubscribe link in already-sent mail still works after unsubscribe→resubscribe (#69)", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);

    // The durable token that past issues embedded in their one-click unsubscribe link.
    const deliveredUnsubToken = await unsubTokenFor(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // Leave, then return (re-subscribe rotates the confirm token) and re-confirm.
    await SELF.fetch(`${base}/unsubscribe?token=${deliveredUnsubToken}`, { method: "POST" });
    await publicSubscribe(email);
    // The durable unsub token is NOT rotated by a re-subscribe — that's the fix.
    expect(await unsubTokenFor(email)).toBe(deliveredUnsubToken);
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // The OLD issue's unsubscribe link (same durable token) still resolves and unsubscribes.
    const late = await SELF.fetch(`${base}/unsubscribe?token=${deliveredUnsubToken}`, {
      method: "POST",
    });
    expect(late.status).toBe(200);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);
  });

  it("a confirm token cannot be used to unsubscribe", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    const confirmToken = await tokenFor(email);
    await SELF.fetch(`${base}/confirm?token=${confirmToken}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // POSTing the confirm token to /unsubscribe must not resolve a subscriber → 400.
    const res = await SELF.fetch(`${base}/unsubscribe?token=${confirmToken}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });

  it("confirm with a bad token returns 400", async () => {
    const res = await SELF.fetch(`${base}/confirm?token=nope`);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email (400)", async () => {
    const res = await publicSubscribe("not-an-email");
    expect(res.status).toBe(400);
  });
});

describe("subscribers: admin + suppressions", () => {
  it("authed POST /subscribers requires auth", async () => {
    const res = await SELF.fetch(`${base}/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail() }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /subscribers returns counts", async () => {
    const res = await SELF.fetch(`${base}/subscribers`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.counts).toHaveProperty("confirmed");
    expect(body.counts).toHaveProperty("suppressed");
  });

  it("suppression excludes a confirmed subscriber, and clearing restores them", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    const add = await SELF.fetch(`${base}/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email, reason: "manual" }),
    });
    expect(add.status).toBe(201);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    const del = await SELF.fetch(`${base}/suppressions/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(await readJson(del)).toMatchObject({ cleared: true });
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });
});

describe("subscribers: admin list filter/search and unsubscribe-by-id", () => {
  it("unsubscribeById flips a confirmed subscriber and is idempotent (I2)", async () => {
    const email = uniqueEmail();
    const { subscriber } = await subs.subscribe(env.DB, email);
    await subs.confirm(env.DB, subscriber.confirm_token!);

    const first = await subs.unsubscribeById(env.DB, subscriber.id);
    expect(first?.status).toBe("unsubscribed");
    expect(first?.unsubscribed_at).toBeTruthy();

    // Re-running is a no-op: status and the original timestamp are unchanged.
    const second = await subs.unsubscribeById(env.DB, subscriber.id);
    expect(second?.status).toBe("unsubscribed");
    expect(second?.unsubscribed_at).toBe(first?.unsubscribed_at);
  });

  it("unsubscribeById returns null for an unknown id", async () => {
    expect(await subs.unsubscribeById(env.DB, "no-such-id")).toBeNull();
  });

  it("listSubscribers filters by status and searches email by substring", async () => {
    const marker = `flt-${Date.now()}-${seq++}`;
    const a = `${marker}-a@example.com`;
    const b = `${marker}-b@example.com`;
    await subs.subscribe(env.DB, a);
    const { subscriber: sb } = await subs.subscribe(env.DB, b);
    await subs.confirm(env.DB, sb.confirm_token!);

    const confirmed = await subs.listSubscribers(env.DB, { status: "confirmed", search: marker });
    expect(confirmed.map((r) => r.email)).toEqual([b]);

    const both = await subs.listSubscribers(env.DB, { search: marker });
    expect(both.map((r) => r.email).sort()).toEqual([a, b].sort());
  });

  it("POST /subscribers/:id/unsubscribe requires auth (401)", async () => {
    const res = await SELF.fetch(`${base}/subscribers/anything/unsubscribe`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /subscribers/:id/unsubscribe is 404 for an unknown id", async () => {
    const res = await SELF.fetch(`${base}/subscribers/no-such-id/unsubscribe`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it("POST /subscribers/:id/unsubscribe flips status and drops them from the audience", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    const id = (await subs.getByEmail(env.DB, email))!.id;
    const res = await SELF.fetch(`${base}/subscribers/${id}/unsubscribe`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ subscriber: { status: "unsubscribed" } });
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);
  });
});
