import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as subs from "../src/db/subscribers";
import type { AppEnv, Config } from "../src/env";
import { ResendProvider, signSvix } from "../src/providers/resend";
import type { Recipient, RenderedEmail } from "../src/providers/types";
import { UNSUB_SENTINEL } from "../src/render/render";
import { applyDeliveryEvents } from "../src/services/webhook_events";

const WHSEC = `whsec_${btoa("kestrel-test-signing-key-0123456789")}`;
const config = { fromAddress: "Newsletter <newsletter@send.example.com>" } as unknown as Config;

function makeProvider(overrides: Partial<AppEnv> = {}): ResendProvider {
  const fakeEnv = {
    RESEND_API_KEY: "re_test_key",
    RESEND_WEBHOOK_SECRET: WHSEC,
    ...overrides,
  } as unknown as AppEnv;
  return new ResendProvider(config, fakeEnv);
}

const rendered: RenderedEmail = {
  subject: "Hello there",
  html: `<p>Hi</p><a href="${UNSUB_SENTINEL}">Unsubscribe</a>`,
  text: `Hi\n\nUnsubscribe: ${UNSUB_SENTINEL}`,
};

function cannedResponse(bodyObj: unknown, status = 200): Response {
  return new Response(JSON.stringify(bodyObj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResendProvider.sendBatch", () => {
  it("posts one array element per recipient with substituted unsubscribe + headers", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cannedResponse({ data: [{ id: "re_1" }, { id: "re_2" }] }));

    const recipients: Recipient[] = [
      { email: "a@example.com", unsubscribeUrl: "https://app.test/unsubscribe?token=aaa" },
      { email: "b@example.com", unsubscribeUrl: "https://app.test/unsubscribe?token=bbb" },
    ];

    const results = await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "send-123",
    });

    // --- request shape ---
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails/batch");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Idempotency-Key"]).toMatch(/^send-123-/);

    const arr = JSON.parse(init.body as string) as Array<Record<string, any>>;
    expect(arr).toHaveLength(2);
    const [e0, e1] = arr as [Record<string, any>, Record<string, any>];
    expect(e0.from).toBe(config.fromAddress);
    expect(e0.to).toEqual(["a@example.com"]);
    expect(e0.subject).toBe("Hello there");
    // sentinel is substituted per element with THAT recipient's URL
    expect(e0.html).toContain("https://app.test/unsubscribe?token=aaa");
    expect(e0.html).not.toContain(UNSUB_SENTINEL);
    expect(e0.text).toContain("https://app.test/unsubscribe?token=aaa");
    expect(e1.html).toContain("https://app.test/unsubscribe?token=bbb");
    // RFC 8058 one-click headers, angle-bracketed URL
    expect(e0.headers["List-Unsubscribe"]).toBe("<https://app.test/unsubscribe?token=aaa>");
    expect(e0.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // --- response mapping ---
    expect(results).toEqual({
      kind: "answered",
      results: [
        { email: "a@example.com", accepted: true, providerId: "re_1" },
        { email: "b@example.com", accepted: true, providerId: "re_2" },
      ],
    });
  });

  it("asks for permissive validation, so one invalid item can't refuse the batch", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cannedResponse({ data: [{ id: "re_1" }] }));
    await makeProvider().sendBatch(
      rendered,
      [{ email: "a@example.com", unsubscribeUrl: "https://app.test/u?t=a" }],
      { idempotencyKeyPrefix: "s" },
    );
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-batch-validation"]).toBe("permissive");
  });

  it("accepts the valid recipients and fails only the invalid one, matching ids by index", async () => {
    // Permissive mode lists the refused item by its index and leaves it out of `data`,
    // so `data[i]` no longer lines up with recipient i past the refused one.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cannedResponse({
        data: [{ id: "re_a" }, { id: "re_c" }, { id: "re_d" }],
        errors: [{ index: 1, message: "Invalid `to` field." }],
      }),
    );
    const recipients: Recipient[] = ["a", "b", "c", "d"].map((x) => ({
      email: `${x}@example.com`,
      unsubscribeUrl: `https://app.test/u?t=${x}`,
    }));
    const result = await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "s",
    });
    expect(result).toEqual({
      kind: "answered",
      results: [
        { email: "a@example.com", accepted: true, providerId: "re_a" },
        {
          email: "b@example.com",
          accepted: false,
          retryable: false,
          error: "Resend: Invalid `to` field.",
        },
        { email: "c@example.com", accepted: true, providerId: "re_c" },
        { email: "d@example.com", accepted: true, providerId: "re_d" },
      ],
    });
  });

  // Resend's docs don't say whether `data` leaves a refused item out or keeps its slot,
  // and the two only differ when the refused item isn't last, so both are pinned here.
  it.each([
    ["leaves refused items out", [{ id: "re_b" }, { id: "re_c" }]],
    ["keeps a slot per request item", [null, { id: "re_b" }, { id: "re_c" }]],
    ["keeps an empty slot per request item", [{}, { id: "re_b" }, { id: "re_c" }]],
  ])("matches ids to recipients when `data` %s", async (_label, data) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cannedResponse({ data, errors: [{ index: 0, message: "Invalid `to` field." }] }),
    );
    const recipients: Recipient[] = ["a", "b", "c"].map((x) => ({
      email: `${x}@example.com`,
      unsubscribeUrl: `https://app.test/u?t=${x}`,
    }));
    const result = await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "s",
    });
    expect(result.kind === "answered" && result.results).toEqual([
      expect.objectContaining({ email: "a@example.com", accepted: false, retryable: false }),
      { email: "b@example.com", accepted: true, providerId: "re_b" },
      { email: "c@example.com", accepted: true, providerId: "re_c" },
    ]);
  });

  it("leaves every recipient not refused retryable when the ids don't add up", async () => {
    // Two ids for three unrefused recipients: which id is whose is a guess, so no one is
    // marked accepted on it; the re-send goes under the same idempotency key.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cannedResponse({
        data: [{ id: "re_x" }, { id: "re_y" }],
        errors: [{ index: 0, message: "Invalid `to` field." }],
      }),
    );
    const recipients: Recipient[] = ["a", "b", "c", "d"].map((x) => ({
      email: `${x}@example.com`,
      unsubscribeUrl: `https://app.test/u?t=${x}`,
    }));
    const result = await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "s",
    });
    expect(result.kind === "answered" && result.results).toEqual([
      expect.objectContaining({ email: "a@example.com", accepted: false, retryable: false }),
      expect.objectContaining({ email: "b@example.com", accepted: false, retryable: true }),
      expect.objectContaining({ email: "c@example.com", accepted: false, retryable: true }),
      expect.objectContaining({ email: "d@example.com", accepted: false, retryable: true }),
    ]);
  });

  it("derives a stable Idempotency-Key per chunk (same recipients => same key)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cannedResponse({ data: [{ id: "re_1" }] }));
    const recipients: Recipient[] = [
      { email: "a@example.com", unsubscribeUrl: "https://app.test/u?t=a" },
    ];
    const opts = { idempotencyKeyPrefix: "send-xyz" };

    await makeProvider().sendBatch(rendered, recipients, opts);
    await makeProvider().sendBatch(rendered, recipients, opts);

    const key1 = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const key2 = (spy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(key1["Idempotency-Key"]).toBe(key2["Idempotency-Key"]);
  });

  it("sends a caller's own Idempotency-Key verbatim (a test send's key, unique per press)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(cannedResponse({ data: [{ id: "re_1" }] }));
    const recipients: Recipient[] = [
      { email: "a@example.com", unsubscribeUrl: "https://app.test/u?t=a" },
    ];
    await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "test-p1",
      idempotencyKey: "test-p1-first",
    });
    await makeProvider().sendBatch(rendered, recipients, {
      idempotencyKeyPrefix: "test-p1",
      idempotencyKey: "test-p1-second",
    });
    const keys = spy.mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toEqual(["test-p1-first", "test-p1-second"]);
  });

  const one = [{ email: "a@example.com", unsubscribeUrl: "https://app.test/u?t=a" }];

  it.each([
    [429, { name: "rate_limit_exceeded", message: "Too many requests." }, "rate_limit", false],
    [500, { name: "application_error", message: "An unexpected error occurred." }, "outage", true],
    [
      503,
      { name: "service_unavailable", message: "API is temporarily unavailable" },
      "outage",
      true,
    ],
    [409, { name: "concurrent_idempotent_requests", message: "In progress." }, "outage", true],
  ])("halts the batch as unavailable on a %i %o", async (status, body, cause, mayHaveSent) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(cannedResponse(body, status));
    const result = await makeProvider().sendBatch(rendered, one, { idempotencyKeyPrefix: "s" });
    expect(result).toMatchObject({
      kind: "halted",
      halt: { reason: "unavailable", cause, mayHaveSent },
    });
  });

  it.each([
    [
      401,
      { name: "missing_api_key", message: "Missing API key in the authorization header." },
      "credentials",
    ],
    [403, { name: "restricted_api_key", message: "API key is not active" }, "credentials"],
    [403, { name: "suspended_api_key", message: "This API key is suspended" }, "suspended"],
    [
      403,
      { name: "validation_error", message: "The example.com domain is not verified." },
      "sender",
    ],
    [
      403,
      {
        name: "validation_error",
        message: "You can only send testing emails to your own email address.",
      },
      "sender",
    ],
    [400, { name: "invalid_api_key", message: "API key is invalid" }, "credentials"],
    [
      429,
      { name: "daily_quota_exceeded", message: "You have exceeded your daily quota." },
      "quota",
    ],
    [
      429,
      { name: "monthly_quota_exceeded", message: "You have exceeded your monthly quota." },
      "quota",
    ],
    [422, { name: "invalid_from_address", message: "Invalid `from` field." }, "sender"],
  ])("halts the batch as an account refusal on a %i %o", async (status, body, cause) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(cannedResponse(body, status));
    const result = await makeProvider().sendBatch(rendered, one, { idempotencyKeyPrefix: "s" });
    expect(result).toMatchObject({
      kind: "halted",
      halt: { reason: "account", cause, mayHaveSent: false },
    });
    // Resend's own name and words, not its raw JSON.
    expect(result.kind === "halted" && result.halt.error).toBe(
      `Resend ${status} ${body.name}: ${body.message}`,
    );
  });

  it("never carries the API key in a halt's error, even when Resend echoes it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cannedResponse({ name: "invalid_api_key", message: "API key re_test_key is invalid" }, 403),
    );
    const result = await makeProvider().sendBatch(rendered, one, { idempotencyKeyPrefix: "s" });
    expect(result.kind).toBe("halted");
    expect(JSON.stringify(result)).not.toContain("re_test_key");
  });

  it("maps a 422 validation error to a non-retryable failure for each recipient", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cannedResponse({ name: "validation_error", message: "bad" }, 422),
    );
    const result = await makeProvider().sendBatch(rendered, one, { idempotencyKeyPrefix: "s" });
    expect(result.kind).toBe("answered");
    expect(result.kind === "answered" && result.results[0]).toMatchObject({
      email: "a@example.com",
      accepted: false,
      retryable: false,
    });
  });
});

// --- webhook: signature verification + event normalization + reconciliation ---

async function signedRequest(
  payload: unknown,
  opts: { tamper?: boolean; timestamp?: string } = {},
) {
  const id = "msg_test_1";
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  let signature = await signSvix(WHSEC, id, timestamp, body);
  if (opts.tamper) {
    signature = `${signature.slice(0, -3)}AAA`;
  }
  return new Request("https://kestrel.test/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

async function seedDelivery(providerId: string, email: string): Promise<void> {
  const now = Date.now();
  // FKs are enforced in the test runtime, so a delivery needs a send, and a send
  // needs a post. INSERT OR IGNORE keeps the shared parent rows idempotent.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-wh','p-wh','sent',?,?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s-wh','p-wh','sending',?, '', '', '', ?)",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO deliveries (id, send_id, email, status, provider_id, attempts, updated_at) VALUES (?, 's-wh', ?, 'accepted', ?, 0, ?)",
  )
    .bind(`d-${providerId}`, email, providerId, now)
    .run();
}

// The shared webhook-events applier records the provider outcome in the separate
// `event` column and leaves the send-loop `status` untouched, so
// a reconciled delivery reads its outcome from `event`, not `status`.
async function deliveryEvent(providerId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = ?")
    .bind(providerId)
    .first<{ event: string | null }>();
  return row?.event ?? undefined;
}

beforeEach(async () => {
  // Delete children before parents (FKs are enforced here).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
});

describe("ResendProvider.parseWebhook", () => {
  it("verifies a valid signature and reconciles a hard bounce into a suppression", async () => {
    await seedDelivery("re_bounce", "bad@example.com");
    const req = await signedRequest({
      type: "email.bounced",
      data: {
        email_id: "re_bounce",
        to: ["bad@example.com"],
        bounce: { type: "Permanent", message: "mailbox does not exist" },
      },
    });

    const result = await makeProvider().parseWebhook(req, env);
    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      {
        type: "bounced",
        providerId: "re_bounce",
        email: "bad@example.com",
        hard: true,
        detail: "mailbox does not exist",
      },
    ]);

    await applyDeliveryEvents(env.DB, result.events);
    expect(await deliveryEvent("re_bounce")).toBe("bounced");
    expect(await subs.isSuppressed(env.DB, "bad@example.com")).toBe(true);
    const [sup] = await subs.listSuppressions(env.DB);
    expect(sup).toMatchObject({ email: "bad@example.com", reason: "bounce" });
  });

  it("reconciles a complaint into a suppression", async () => {
    await seedDelivery("re_spam", "angry@example.com");
    const req = await signedRequest({
      type: "email.complained",
      data: { email_id: "re_spam", to: ["angry@example.com"] },
    });

    const result = await makeProvider().parseWebhook(req, env);
    expect(result.events).toEqual([
      { type: "complained", providerId: "re_spam", email: "angry@example.com", detail: undefined },
    ]);

    await applyDeliveryEvents(env.DB, result.events);
    expect(await deliveryEvent("re_spam")).toBe("complained");
    const [sup] = await subs.listSuppressions(env.DB);
    expect(sup).toMatchObject({ email: "angry@example.com", reason: "complaint" });
  });

  it("marks a delivery delivered without suppressing", async () => {
    await seedDelivery("re_ok", "good@example.com");
    const req = await signedRequest({
      type: "email.delivered",
      data: { email_id: "re_ok", to: ["good@example.com"] },
    });

    const result = await makeProvider().parseWebhook(req, env);
    expect(result.events).toEqual([
      { type: "delivered", providerId: "re_ok", email: "good@example.com" },
    ]);

    await applyDeliveryEvents(env.DB, result.events);
    expect(await deliveryEvent("re_ok")).toBe("delivered");
    expect(await subs.isSuppressed(env.DB, "good@example.com")).toBe(false);
  });

  it("rejects a tampered signature with 401 and no events", async () => {
    const req = await signedRequest(
      { type: "email.delivered", data: { email_id: "re_ok", to: ["good@example.com"] } },
      { tamper: true },
    );
    const result = await makeProvider().parseWebhook(req, env);
    expect(result.response.status).toBe(401);
    expect(result.events).toHaveLength(0);
  });

  it("rejects a stale timestamp with 400", async () => {
    const req = await signedRequest(
      { type: "email.delivered", data: { email_id: "re_ok", to: ["good@example.com"] } },
      { timestamp: String(Math.floor(Date.now() / 1000) - 3600) },
    );
    const result = await makeProvider().parseWebhook(req, env);
    expect(result.response.status).toBe(400);
    expect(result.events).toHaveLength(0);
  });

  it("treats a Transient bounce as soft (no suppression)", async () => {
    await seedDelivery("re_soft", "temp@example.com");
    const req = await signedRequest({
      type: "email.bounced",
      data: {
        email_id: "re_soft",
        to: ["temp@example.com"],
        bounce: { type: "Transient", message: "mailbox full" },
      },
    });
    const result = await makeProvider().parseWebhook(req, env);
    expect(result.events[0]).toMatchObject({ type: "bounced", hard: false });

    await applyDeliveryEvents(env.DB, result.events);
    expect(await deliveryEvent("re_soft")).toBe("bounced");
    expect(await subs.isSuppressed(env.DB, "temp@example.com")).toBe(false);
  });
});

// --- the public route is reachable without auth (signature is the gate) ---

describe("POST /webhooks/resend route", () => {
  it("is public (not behind requireAuth): an unsigned POST is not 401", async () => {
    const res = await SELF.fetch("https://kestrel.test/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.delivered" }),
    });
    // With the dev/fake provider active it acks 200; the point is it's not 401.
    expect(res.status).not.toBe(401);
  });
});
