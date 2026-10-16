import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import * as settings from "../src/db/settings";
import * as subs from "../src/db/subscribers";
import { type AppEnv, getConfig } from "../src/env";
import { CONFIRM_COOLDOWN_MS, CONFIRM_LINK_TTL_MS } from "../src/lib/time";
import * as providers from "../src/providers";
import type { EmailProvider, SendBatchResult } from "../src/providers/types";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { fetchWith } from "./support/worker_env";

let seq = 0;
const uniqueEmail = () => `person-${Date.now()}-${seq++}@example.com`;

/** Dispatch through the real router and wait for its background work, since the public
 *  form answers before it subscribes anyone or sends a confirmation. */
async function route(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const e = env as AppEnv;
  const res = await createRouter(getConfig(e)).handle(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function publicSubscribe(email: string): Promise<Response> {
  return route(
    new Request(`${base}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
}

/** The public form's own submission: urlencoded, answered with a page. */
async function formSubscribe(email: string): Promise<Response> {
  return route(
    new Request(`${base}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    }),
  );
}

async function adminAdd(email: string): Promise<Response> {
  return SELF.fetch(`${base}/api/subscribers`, {
    method: "POST",
    headers: JSON_AUTH,
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

/** The confirm page's button: the POST that records consent. */
async function confirmToken(token: string): Promise<Response> {
  return SELF.fetch(`${base}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

async function confirmEmail(email: string): Promise<Response> {
  return confirmToken(await tokenFor(email));
}

/** Confirmations the fake transport delivered to `email`. */
async function confirmationsTo(email: string): Promise<number> {
  const outbox = await readJson(await SELF.fetch(`${base}/api/dev/outbox`, { headers: AUTH }));
  return outbox.messages.filter(
    (m: any) => m.to === email && m.subject === "Confirm your subscription",
  ).length;
}

/** Move the address's last confirmation `ms` into the past, as if that long had gone by. */
async function ageConfirmation(email: string, ms: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE subscribers SET confirm_sent_at = confirm_sent_at - ?, confirm_attempt_at = confirm_attempt_at - ? WHERE email = ?",
  )
    .bind(ms, ms, email)
    .run();
}

/** A pending row whose confirmation went out, without going through a route. */
async function addPending(email: string): Promise<subs.SubscriberRow> {
  const { subscriber } = await subs.ensureSubscriber(env.DB, email);
  const now = Date.now();
  expect(await subs.claimConfirmation(env.DB, subscriber.id, now, now)).toBe(true);
  const armed = await subs.armConfirmation(
    env.DB,
    subscriber.id,
    `tok-${subscriber.id}`,
    now,
    subscriber.status,
  );
  expect(armed).toBe(true);
  return (await subs.getById(env.DB, subscriber.id))!;
}

async function addConfirmed(email: string): Promise<subs.SubscriberRow> {
  const pending = await addPending(email);
  return (await subs.confirm(env.DB, pending.confirm_token!, 0))!;
}

describe("subscribers: double opt-in (I1) and unsubscribe (I2)", () => {
  it("public subscribe creates a pending subscriber and emails a confirmation", async () => {
    const email = uniqueEmail();
    const res = await publicSubscribe(email);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ status: "check_inbox" });
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("pending");
    expect(await confirmationsTo(email)).toBe(1);
  });

  it("only confirmed subscribers are in the audience (I1)", async () => {
    const pendingEmail = uniqueEmail();
    const confirmedEmail = uniqueEmail();
    await publicSubscribe(pendingEmail);
    await publicSubscribe(confirmedEmail);

    const res = await confirmEmail(confirmedEmail);
    expect(res.status).toBe(200);

    const audience = await subs.audienceEmails(env.DB);
    expect(audience).toContain(confirmedEmail);
    expect(audience).not.toContain(pendingEmail);
  });

  it("unsubscribe is immediate and final (I2), and re-subscribe requires re-confirmation", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await confirmEmail(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // one-click unsubscribe via the durable unsub token (empty body, no html accept)
    const unsub = await SELF.fetch(`${base}/unsubscribe?token=${await unsubTokenFor(email)}`, {
      method: "POST",
    });
    expect(unsub.status).toBe(200);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // re-subscribe once the cooldown has passed → pending again (NOT auto-confirmed)
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    await publicSubscribe(email);
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("pending");
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);

    // confirm with the fresh confirm token → back in the audience
    await confirmEmail(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });

  it("the unsubscribe link in already-sent mail still works after unsubscribe→resubscribe", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await confirmEmail(email);

    // The durable token that past posts embedded in their one-click unsubscribe link.
    const deliveredUnsubToken = await unsubTokenFor(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // Leave, then return (re-subscribe rotates the confirm token) and re-confirm.
    await SELF.fetch(`${base}/unsubscribe?token=${deliveredUnsubToken}`, { method: "POST" });
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    await publicSubscribe(email);
    // The durable unsub token is NOT rotated by a re-subscribe.
    expect(await unsubTokenFor(email)).toBe(deliveredUnsubToken);
    await confirmEmail(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // The OLD post's unsubscribe link (same durable token) still resolves and unsubscribes.
    const late = await SELF.fetch(`${base}/unsubscribe?token=${deliveredUnsubToken}`, {
      method: "POST",
    });
    expect(late.status).toBe(200);
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);
  });

  it("a confirm token cannot be used to unsubscribe", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    const confirmTok = await tokenFor(email);
    await confirmToken(confirmTok);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    // POSTing the confirm token to /unsubscribe must not resolve a subscriber → 400.
    const res = await SELF.fetch(`${base}/unsubscribe?token=${confirmTok}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });

  it("confirm with a bad token returns 400, on the page and on the button", async () => {
    expect((await SELF.fetch(`${base}/confirm?token=nope`)).status).toBe(400);
    expect((await confirmToken("nope")).status).toBe(400);
  });

  it("rejects an invalid email (400)", async () => {
    const res = await publicSubscribe("not-an-email");
    expect(res.status).toBe(400);
  });
});

describe("confirming: only the owner's click records consent (I1)", () => {
  it("opening the link changes nothing; the page's button confirms", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    const token = await tokenFor(email);

    // A mail scanner fetching the link, twice.
    for (let i = 0; i < 2; i++) {
      const page = await SELF.fetch(`${base}/confirm?token=${token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(`action="/confirm"`);
      expect(html).toContain(`name="token" value="${token}"`);
    }
    const untouched = await subs.getByEmail(env.DB, email);
    expect(untouched).toMatchObject({ status: "pending", confirmed_at: null });

    const res = await confirmToken(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/subscribed/);
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("confirmed");

    // The button again, or the link again, lands on the confirmed page.
    expect((await confirmToken(token)).status).toBe(200);
    expect(await (await SELF.fetch(`${base}/confirm?token=${token}`)).text()).toMatch(
      /You’re subscribed/,
    );
  });

  it("an expired link does not confirm, and its page offers a fresh one", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    const token = await tokenFor(email);
    await ageConfirmation(email, CONFIRM_LINK_TTL_MS);

    const res = await confirmToken(token);
    expect(res.status).toBe(410);
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("pending");
    const beforeGet = await subs.getByEmail(env.DB, email);
    const page = await SELF.fetch(`${base}/confirm?token=${token}`);
    expect(page.status).toBe(410);
    expect(await subs.getByEmail(env.DB, email)).toEqual(beforeGet);
    const html = await page.text();
    expect(html).toContain(`action="/subscribe"`);
    expect(html).toContain(`name="email" value="${email}"`);

    // The offer is the ordinary subscribe: a new link, which works.
    expect(await confirmationsTo(email)).toBe(1);
    await formSubscribe(email);
    expect(await confirmationsTo(email)).toBe(2);
    const fresh = await tokenFor(email);
    expect(fresh).not.toBe(token);
    expect((await confirmToken(token)).status).toBe(400); // the old link is spent
    expect((await confirmToken(fresh)).status).toBe(200);
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("confirmed");
  });
});

describe("subscribing: no flood, and no reveal of who is on the list", () => {
  it("racing subscribes for one address send one confirmation between them", async () => {
    const email = uniqueEmail();
    const answers = await Promise.all([1, 2, 3, 4].map(() => publicSubscribe(email)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await confirmationsTo(email)).toBe(1);
  });

  it("a link left pending and then unsubscribed no longer confirms", async () => {
    const email = uniqueEmail();
    const pending = await addPending(email);
    await subs.unsubscribeById(env.DB, pending.id);
    expect((await confirmToken(pending.confirm_token!)).status).toBe(400);
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("unsubscribed");
  });

  it("stores a suppression lowercased, and keeps the erased rule across casings", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email.toUpperCase(), subs.ERASED);
    expect(await subs.isSuppressed(env.DB, email)).toBe(true);
    await subs.addSuppression(env.DB, ` ${email.toUpperCase()} `, "bounce");
    await subs.addSuppression(env.DB, email.toUpperCase(), subs.ERASED);
    const rows = (await subs.listSuppressions(env.DB)).filter(
      (r) => r.email.toLowerCase() === email,
    );
    expect(rows).toEqual([expect.objectContaining({ email, reason: "bounce" })]);
  });

  it("a bounce or complaint on an erased address replaces the marker and blocks confirmations", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email, subs.ERASED);
    await subs.addSuppression(env.DB, email, "bounce", "hard bounce");
    expect((await subs.listSuppressions(env.DB)).find((r) => r.email === email)?.reason).toBe(
      "bounce",
    );
    await publicSubscribe(email);
    expect(await confirmationsTo(email)).toBe(0);

    // And the reverse: a later erased marker never overwrites a bounce.
    await subs.addSuppression(env.DB, email, subs.ERASED);
    expect((await subs.listSuppressions(env.DB)).find((r) => r.email === email)?.reason).toBe(
      "bounce",
    );
  });

  it("repeated subscribes inside the cooldown send one confirmation, and keep its link", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 5; i++) {
      expect((await publicSubscribe(email)).status).toBe(200);
    }
    expect(await confirmationsTo(email)).toBe(1);
    const token = await tokenFor(email);

    // The admin Add says why it sent nothing.
    expect(await readJson(await adminAdd(email))).toMatchObject({ action: "recently_sent" });

    // Once the cooldown has passed, the next request sends another.
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    await publicSubscribe(email);
    expect(await confirmationsTo(email)).toBe(2);
    expect(await tokenFor(email)).not.toBe(token);
  });

  it("a suppressed address is never sent a confirmation", async () => {
    const neverListed = uniqueEmail();
    const leftAndBounced = uniqueEmail();
    await subs.addSuppression(env.DB, neverListed, "complaint");
    await addConfirmed(leftAndBounced);
    await subs.unsubscribeById(env.DB, (await subs.getByEmail(env.DB, leftAndBounced))!.id);
    await subs.addSuppression(env.DB, leftAndBounced, "bounce");

    for (const email of [neverListed, leftAndBounced]) {
      expect((await publicSubscribe(email)).status).toBe(200);
      expect(await readJson(await adminAdd(email))).toMatchObject({ action: "suppressed" });
      expect(await confirmationsTo(email)).toBe(0);
    }
    expect(await subs.getByEmail(env.DB, neverListed)).toBeNull();
    expect(await readJson(await adminAdd(neverListed))).toEqual({
      subscriber: null,
      action: "suppressed",
    });
    expect((await subs.getByEmail(env.DB, leftAndBounced))?.status).toBe("unsubscribed");
  });

  it("an erased address can come back, and its confirmation lifts the marker", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email, subs.ERASED);

    await publicSubscribe(email);
    expect(await confirmationsTo(email)).toBe(1);
    expect(await subs.isSuppressed(env.DB, email)).toBe(true); // not until they confirm

    await confirmEmail(email);
    expect(await subs.isSuppressed(env.DB, email)).toBe(false);
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });

  it("every state gets the same answer, as JSON and as a page", async () => {
    const fresh = uniqueEmail();
    const pending = uniqueEmail();
    const coolingDown = uniqueEmail();
    const confirmed = uniqueEmail();
    const unsubscribed = uniqueEmail();
    const suppressed = uniqueEmail();
    const erased = uniqueEmail();
    await addPending(pending);
    await ageConfirmation(pending, CONFIRM_COOLDOWN_MS);
    await addPending(coolingDown);
    await addConfirmed(confirmed);
    await addConfirmed(unsubscribed);
    await subs.unsubscribeById(env.DB, (await subs.getByEmail(env.DB, unsubscribed))!.id);
    await ageConfirmation(unsubscribed, CONFIRM_COOLDOWN_MS);
    await addConfirmed(suppressed);
    await subs.addSuppression(env.DB, suppressed, "complaint");
    await subs.addSuppression(env.DB, erased, subs.ERASED);

    const states = [fresh, pending, coolingDown, confirmed, unsubscribed, suppressed, erased];
    const answers = new Set<string>();
    const pages = new Set<string>();
    for (const email of states) {
      const res = await publicSubscribe(email);
      answers.add(`${res.status} ${await res.text()}`);
      const page = await formSubscribe(email);
      pages.add(`${page.status} ${await page.text()}`);
    }
    expect([...answers]).toEqual([`200 ${JSON.stringify({ status: "check_inbox" })}`]);
    expect(pages.size).toBe(1);
    expect([...pages][0]).toMatch(/^200 [\s\S]*Check your inbox/);
  });
});

describe("a confirmation the provider does not take is not treated as sent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A transport that answers every confirmation with `answer`, or throws when it's null. */
  function stubProvider(
    answer: (to: string) => SendBatchResult | null | Promise<SendBatchResult>,
  ): { calls: string[] } {
    const calls: string[] = [];
    const stub: EmailProvider = {
      name: "ses",
      maxBatch: 100,
      async sendBatch(_rendered, recipients) {
        const to = recipients[0]!.email;
        calls.push(to);
        const result = await answer(to);
        if (!result) {
          throw new Error("socket hang up");
        }
        return result;
      },
      async parseWebhook() {
        throw new Error("unused");
      },
    };
    vi.spyOn(providers, "getProvider").mockReturnValue(stub);
    return { calls };
  }

  const refused =
    (retryable: boolean) =>
    (to: string): SendBatchResult => ({
      kind: "answered",
      results: [{ email: to, accepted: false, retryable, error: "429 too many requests" }],
    });

  for (const retryable of [true, false]) {
    it(`a ${retryable ? "retryable" : "permanent"} refusal of a new address: no row, and the admin is told`, async () => {
      const stub = stubProvider(refused(retryable));
      const email = uniqueEmail();

      // The public answer never changes (it comes before the send); the state says what happened.
      const res = await publicSubscribe(email);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ status: "check_inbox" });
      expect((await formSubscribe(email)).status).toBe(200);
      expect(await subs.getByEmail(env.DB, email)).toBeNull();

      const admin = await adminAdd(email);
      expect(admin.status).toBe(502);
      expect(await readJson(admin)).toMatchObject({
        error: "confirmation_not_sent",
        message: expect.stringContaining("429 too many requests"),
      });
      // A refusal is not a send, so it starts no cooldown: every try reached the provider.
      expect(stub.calls).toEqual([email, email, email]);
    });
  }

  it("a refused resend leaves the last link that arrived working, and no cooldown", async () => {
    const email = uniqueEmail();
    const before = await addPending(email);
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    const aged = (await subs.getByEmail(env.DB, email))!;
    const stub = stubProvider(refused(true));

    await publicSubscribe(email);
    expect(await subs.getByEmail(env.DB, email)).toEqual(aged);
    await publicSubscribe(email);
    expect(stub.calls).toHaveLength(2);

    vi.restoreAllMocks();
    expect((await confirmToken(before.confirm_token!)).status).toBe(200);
  });

  it("a failure before the provider is asked changes nothing", async () => {
    allowErrorLogs("subscribe.failed", "request.error");
    const email = uniqueEmail();
    await addPending(email);
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    const before = await subs.getByEmail(env.DB, email);
    const stub = stubProvider(refused(false));
    vi.spyOn(settings, "getSettings").mockRejectedValue(new Error("settings are corrupt"));

    expect((await publicSubscribe(email)).status).toBe(200);
    expect(await subs.getByEmail(env.DB, email)).toEqual(before);
    expect((await adminAdd(email)).status).toBe(500);
    expect(await subs.getByEmail(env.DB, email)).toEqual(before);
    expect(stub.calls).toHaveLength(0);
  });

  it("an unsubscribe that lands while the confirmation is sent stands (I2)", async () => {
    const email = uniqueEmail();
    const pending = await addPending(email);
    await ageConfirmation(email, CONFIRM_COOLDOWN_MS);
    stubProvider(async (to) => {
      // The owner leaves (by an old link, say) while the provider is taking the email.
      await subs.unsubscribeById(env.DB, pending.id);
      return { kind: "answered", results: [{ email: to, accepted: true, providerId: "p1" }] };
    });
    await publicSubscribe(email);
    const after = (await subs.getByEmail(env.DB, email))!;
    expect(after.status).toBe("unsubscribed");
    expect(after.confirm_token).toBe(pending.confirm_token);
  });

  it("the public form answers before the provider is asked, so its timing says nothing", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubProvider(async (to) => {
      await gate;
      return { kind: "answered", results: [{ email: to, accepted: true, providerId: "p1" }] };
    });
    const email = uniqueEmail();
    const ctx = createExecutionContext();
    const e = env as AppEnv;
    const res = await createRouter(getConfig(e)).handle(
      new Request(`${base}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      e,
      ctx,
    );
    // Answered while the provider still holds the confirmation.
    expect(await readJson(res)).toEqual({ status: "check_inbox" });
    release();
    await waitOnExecutionContext(ctx);
    expect(stub.calls).toEqual([email]);
    expect((await subs.getByEmail(env.DB, email))?.confirm_token).not.toBeNull();
  });

  it("a halted batch is a refusal too", async () => {
    stubProvider(() => ({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "credentials",
        error: "API key is invalid",
      },
    }));
    const email = uniqueEmail();
    await publicSubscribe(email);
    expect(await subs.getByEmail(env.DB, email)).toBeNull();
  });

  it("no answer at all: the link is kept in case it arrived, and the cooldown holds", async () => {
    const stub = stubProvider(() => null);
    const email = uniqueEmail();
    await publicSubscribe(email);
    const row = (await subs.getByEmail(env.DB, email))!;
    expect(row).toMatchObject({ status: "pending" });
    expect(row.confirm_sent_at).not.toBeNull();

    // It may have gone, so the cooldown holds: a retry sends nothing more.
    expect((await publicSubscribe(email)).status).toBe(200);
    expect(stub.calls).toHaveLength(1);

    vi.restoreAllMocks();
    expect((await confirmEmail(email)).status).toBe(200);
  });
});

describe("subscribers: admin + suppressions", () => {
  it("authed POST /api/subscribers requires auth", async () => {
    const res = await SELF.fetch(`${base}/api/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail() }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/subscribers returns counts", async () => {
    // A list of known shape, so each count is checked against what is really there; the
    // suppressed count is subscribers whose address is suppressed, so an address suppressed
    // with no subscriber isn't one.
    await resetDatabase();
    await seedConfirmed(["c1@example.com", "c2@example.com", "c3@example.com"]);
    await env.DB.prepare(
      `INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, unsubscribed_at)
       VALUES ('id-p', 'p@example.com', 'pending', 'cfm-p', 'uns-p', 0, NULL),
              ('id-u', 'u@example.com', 'unsubscribed', NULL, 'uns-u', 0, 0)`,
    ).run();
    await subs.addSuppression(env.DB, "c1@example.com", "manual");
    await subs.addSuppression(env.DB, "elsewhere@example.com", "bounce");

    const res = await SELF.fetch(`${base}/api/subscribers`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.counts).toEqual({ confirmed: 3, pending: 1, unsubscribed: 1, suppressed: 1 });
    // The count is what the suppression facet shows.
    const only = await readJson(
      await SELF.fetch(`${base}/api/subscribers?suppressed=only`, { headers: AUTH }),
    );
    expect(only.page.total).toBe(body.counts.suppressed);
    for (const status of ["confirmed", "pending", "unsubscribed"] as const) {
      const slice = await readJson(
        await SELF.fetch(`${base}/api/subscribers?status=${status}`, { headers: AUTH }),
      );
      expect(slice.page.total).toBe(body.counts[status]);
    }
  });

  it("suppression excludes a confirmed subscriber, and clearing restores them", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await confirmEmail(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    const add = await SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email, reason: "manual", detail: "Our own test address" }),
    });
    expect(add.status).toBe(201);
    expect(await readJson(add)).toEqual({
      suppression: {
        email,
        reason: "manual",
        detail: "Our own test address",
        created_at: expect.any(Number),
      },
      added: true,
    });
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);
    // The block is the publisher's; the subscriber's consent is untouched.
    expect((await subs.getByEmail(env.DB, email))?.status).toBe("confirmed");

    const del = await SELF.fetch(`${base}/api/suppressions/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(await readJson(del)).toMatchObject({ cleared: true });
    expect(await subs.audienceEmails(env.DB)).toContain(email);
  });
});

describe("suppressions: a client records only its own block (SPEC §7)", () => {
  const block = (body: Record<string, unknown>) =>
    SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(body),
    });
  const clear = (email: string) =>
    SELF.fetch(`${base}/api/suppressions/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: AUTH,
    });

  it("blocks with reason manual when none is given", async () => {
    const email = uniqueEmail();
    const res = await block({ email });
    expect(res.status).toBe(201);
    expect((await subs.suppressionOf(env.DB, email))?.reason).toBe("manual");
  });

  it("refuses a reason that would claim the provider's or an erasure's decision, storing nothing", async () => {
    for (const reason of ["bounce", "complaint", "erased", "import_bounce", "spam"]) {
      const email = uniqueEmail();
      const res = await block({ email, reason });
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ error: "bad_request", field: "reason" });
      expect(await subs.suppressionOf(env.DB, email)).toBeNull();
    }
  });

  it("keeps a suppression the address already has, and answers the one that stands", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email, "bounce", "550 no such user");
    const res = await block({ email });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      suppression: { email, reason: "bounce", detail: "550 no such user" },
      added: false,
    });
    expect((await subs.suppressionOf(env.DB, email))?.reason).toBe("bounce");
  });

  it("keeps a block already there, its detail included, rather than answering 200 over a changed one", async () => {
    const email = uniqueEmail();
    await block({ email, detail: "first" });
    const res = await block({ email, detail: "second" });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      suppression: { reason: "manual", detail: "first" },
      added: false,
    });
  });

  it("never blocks over an erasure's marker, so clearing a block can't lift an erasure", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email, "erased");
    const res = await block({ email });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ suppression: { reason: "erased" }, added: false });
    expect((await subs.suppressionOf(env.DB, email))?.reason).toBe("erased");
  });

  it("refuses to clear an erasure's marker, which only the person's confirmation lifts", async () => {
    const email = uniqueEmail();
    await subs.addSuppression(env.DB, email, "erased");
    const res = await clear(email);
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ error: "erasure_marker" });
    expect((await subs.suppressionOf(env.DB, email))?.reason).toBe("erased");
  });

  it("answers cleared: false for an address with no suppression", async () => {
    const email = uniqueEmail();
    const res = await clear(email);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ email, cleared: false });
  });
});

describe("subscribers: admin list filter/search and unsubscribe-by-id", () => {
  it("unsubscribeById flips a confirmed subscriber and is idempotent (I2)", async () => {
    const email = uniqueEmail();
    const subscriber = await addConfirmed(email);

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
    await addPending(a);
    await addConfirmed(b);

    const confirmed = await subs.listSubscribers(env.DB, { status: "confirmed", search: marker });
    expect(confirmed.map((r) => r.email)).toEqual([b]);

    const both = await subs.listSubscribers(env.DB, { search: marker });
    expect(both.map((r) => r.email).sort()).toEqual([a, b].sort());
  });

  it("the suppressed facet: 'only' narrows to suppressed subscribers, 'hide' drops them", async () => {
    const marker = `sup-${Date.now()}-${seq++}`;
    const plain = `${marker}-a@example.com`;
    const suppressed = `${marker}-b@example.com`;
    await addPending(plain);
    await addPending(suppressed);
    await subs.addSuppression(env.DB, suppressed, "bounce");

    const only = await subs.listSubscribers(env.DB, { suppressed: "only", search: marker });
    expect(only.map((r) => r.email)).toEqual([suppressed]);

    const hide = await subs.listSubscribers(env.DB, { suppressed: "hide", search: marker });
    expect(hide.map((r) => r.email)).toEqual([plain]);
  });

  it("GET /api/subscribers?suppressed=only returns only suppressed rows (still badged), with a page envelope", async () => {
    const marker = `supq-${Date.now()}-${seq++}`;
    const plain = `${marker}-a@example.com`;
    const suppressed = `${marker}-b@example.com`;
    await addPending(plain);
    await addPending(suppressed);
    await subs.addSuppression(env.DB, suppressed, "complaint");

    const res = await SELF.fetch(`${base}/api/subscribers?suppressed=only&search=${marker}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.subscribers.map((s: any) => s.email)).toEqual([suppressed]);
    expect(body.subscribers.every((s: any) => s.suppressed)).toBe(true);
    // The suppression reason is surfaced on each row (for the inline flag).
    expect(body.subscribers[0].suppression_reason).toBe("complaint");
    // The page envelope reflects the filtered total, not the whole table.
    expect(body.page).toMatchObject({ total: 1, offset: 0 });
  });

  it("GET /api/subscribers flags a row's suppression however many newer suppressions there are (SPEC §7)", async () => {
    await resetDatabase();
    await seedConfirmed(["old@example.com"]);
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES ('old@example.com', 'bounce', 'mailbox gone', ?)",
    )
      .bind(Date.now() - 60_000)
      .run();
    // 1,001 newer suppressions on addresses not on the list, past the suppression list's cap.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
       INSERT INTO suppressions (email, reason, detail, created_at)
       SELECT 'newer-' || i || '@example.com', 'complaint', NULL, ? FROM n`,
    )
      .bind(Date.now())
      .run();

    const res = await SELF.fetch(`${base}/api/subscribers?search=old@`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.subscribers).toHaveLength(1);
    expect(body.subscribers[0]).toMatchObject({
      email: "old@example.com",
      suppressed: true,
      suppression_reason: "bounce",
      suppression_detail: "mailbox gone",
    });
  });

  it("GET /api/subscribers paginates (offset/limit) and sorts by a whitelisted column", async () => {
    const marker = `pg-${Date.now()}-${seq++}`;
    // Three subscribers whose emails sort a < b < c.
    for (const s of ["a", "b", "c"]) {
      await addPending(`${marker}-${s}@example.com`);
    }
    const q = `search=${marker}&sort=email&dir=asc`;

    const page1 = await readJson(
      await SELF.fetch(`${base}/api/subscribers?${q}&limit=2&offset=0`, { headers: AUTH }),
    );
    expect(page1.subscribers.map((s: any) => s.email)).toEqual([
      `${marker}-a@example.com`,
      `${marker}-b@example.com`,
    ]);
    expect(page1.page).toMatchObject({ total: 3, limit: 2, offset: 0, sort: "email", dir: "asc" });

    const page2 = await readJson(
      await SELF.fetch(`${base}/api/subscribers?${q}&limit=2&offset=2`, { headers: AUTH }),
    );
    expect(page2.subscribers.map((s: any) => s.email)).toEqual([`${marker}-c@example.com`]);
  });

  it("an out-of-whitelist sort is a 400 naming the field (never a 500), including prototype keys", async () => {
    const marker = `srt-${Date.now()}-${seq++}`;
    await addPending(`${marker}@example.com`);
    // `constructor`/`toString`/`hasOwnProperty` are inherited Object keys: the whitelist
    // must reject them by ownership, not `in`, or they'd reach the ORDER BY as SQL.
    for (const bogus of ["bogus", "constructor", "toString", "hasOwnProperty"]) {
      const res = await SELF.fetch(`${base}/api/subscribers?sort=${bogus}&search=${marker}`, {
        headers: AUTH,
      });
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ error: "bad_request", field: "sort" });
    }
  });

  it("POST /api/subscribers/:id/unsubscribe requires auth (401)", async () => {
    const res = await SELF.fetch(`${base}/api/subscribers/anything/unsubscribe`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/subscribers/:id/unsubscribe is 404 for an unknown id", async () => {
    const res = await SELF.fetch(`${base}/api/subscribers/no-such-id/unsubscribe`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/subscribers/:id/unsubscribe flips status and drops them from the audience", async () => {
    const email = uniqueEmail();
    await publicSubscribe(email);
    await confirmEmail(email);
    expect(await subs.audienceEmails(env.DB)).toContain(email);

    const id = (await subs.getByEmail(env.DB, email))!.id;
    const res = await SELF.fetch(`${base}/api/subscribers/${id}/unsubscribe`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ subscriber: { status: "unsubscribed" } });
    expect(await subs.audienceEmails(env.DB)).not.toContain(email);
  });
});

describe("the list past what Workers Free suits (SPEC §7)", () => {
  const PAID = { SUBREQUEST_BUDGET: "10000" };
  const advice = async (vars: Record<string, string> = {}) =>
    (await readJson(await fetchWith(vars, `${base}/api/subscribers`, { headers: AUTH })))
      .workers_plan_advice;

  it("carries the advice to move to Workers Paid once the confirmed list passes 1,000, on Free's limits only", async () => {
    await resetDatabase();
    await seedConfirmed(Array.from({ length: 1_000 }, (_, i) => `r${i}@example.com`));
    expect(await advice()).toBe(null); // 1,000: what Free suits
    await seedConfirmed(["one-more@example.com"]);
    expect(await advice()).toBe(
      "This list has 1,001 confirmed subscribers, on the Workers Free plan’s limits. Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day’s database writes and stop this newsletter until midnight UTC. Move to Workers Paid, or, if the account is on it already, set SUBREQUEST_BUDGET to 10000.",
    );
    expect(await advice(PAID)).toBe(null);
  });
});
