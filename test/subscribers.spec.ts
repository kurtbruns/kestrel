import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as subs from "../src/db/subscribers";

const AUTH = { Authorization: "Bearer test-bearer-token" };
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

async function tokenFor(email: string): Promise<string> {
  const row = await subs.getByEmail(env.DB, email);
  return row!.token;
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
    const token = await tokenFor(email);
    await SELF.fetch(`${base}/confirm?token=${token}`);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // one-click unsubscribe (empty body, token in query, no html accept)
    const unsub = await SELF.fetch(`${base}/unsubscribe?token=${token}`, { method: "POST" });
    expect(unsub.status).toBe(200);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // re-subscribe → pending again (NOT auto-confirmed)
    const re = await readJson(await publicSubscribe(email));
    expect(re).toMatchObject({ status: "pending", action: "resubscribed" });
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // confirm with the fresh token → back in the audience
    await SELF.fetch(`${base}/confirm?token=${await tokenFor(email)}`);
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
