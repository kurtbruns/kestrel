/**
 * End-to-end delivery integration (pre-live confidence check).
 *
 * The per-adapter specs (`provider_ses`, `provider_resend`) exercise each adapter
 * in isolation. This spec instead drives the REAL wiring that a live run hits,
 * with only the outbound network mocked:
 *
 *   - the send loop (`runSend`) selecting the configured provider via `getConfig`
 *     + `getProvider`, chunking to `maxBatch`, and recording `provider_id`;
 *   - the actual router (`createRouter(config).handle`) dispatching `POST /webhooks/*`
 *     to that same provider and applying the normalized events;
 *   - the full loop: send -> provider id recorded -> signed webhook bounce ->
 *     suppression -> the address is dropped from the NEXT send's audience (SPEC §7, §10).
 *
 * PROVIDER is switched per test by passing an env override to `runSend` /
 * `handle` (both resolve config from env), so this proves the reconciled factory
 * wires BOTH `ses` and `resend` and both `/webhooks/*` routes are live and public.
 * No real credentials or network: SES send/cert fetches and Resend batch calls
 * are mocked; Svix/SNS payloads are signed locally.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import * as sends from "../src/db/sends";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { signSvix } from "../src/providers/resend";
import { _clearKeyCache, type SnsEnvelope } from "../src/providers/sns";
import { runSend } from "../src/send/loop";
import { RESEND_DEPLOY, SES_DEPLOY, SNS_TOPIC_ARN } from "./support/deploy";
import { dueSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { base } from "./support/http";
import { makeSigner, type Signer, signEnvelope } from "./support/sns";

// --- env overrides ----------------------------------------------------------

// The deploy constants carry the credentials; the configuration set is what routes SES's
// events to the SNS topic in a real deploy, so a send names it.
const sesEnv = () =>
  ({ ...env, ...SES_DEPLOY, SES_CONFIGURATION_SET: "kestrel-events" }) as unknown as AppEnv;

const resendEnv = () => ({ ...env, ...RESEND_DEPLOY }) as unknown as AppEnv;

// --- seeding helpers --------------------------------------------------------

async function providerIdFor(email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT provider_id FROM deliveries WHERE email = ?")
    .bind(email)
    .first<{ provider_id: string | null }>();
  return row?.provider_id ?? null;
}

// --- SNS signing (SES), with a local RSA key ---------------------------------

function signedSnsBounce(signer: Signer, email: string, providerId: string): Promise<SnsEnvelope> {
  const message = JSON.stringify({
    notificationType: "Bounce",
    mail: { messageId: providerId, destination: [email] },
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: email, diagnosticCode: "smtp; 550 user unknown" }],
    },
  });
  return signEnvelope(
    {
      Type: "Notification",
      MessageId: crypto.randomUUID(),
      TopicArn: SNS_TOPIC_ARN,
      Message: message,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: signer.certUrl,
    },
    signer,
  );
}

// --- Svix signing (Resend) --------------------------------------------------

async function signedResendWebhook(payload: unknown): Promise<Request> {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = await signSvix(RESEND_DEPLOY.RESEND_WEBHOOK_SECRET, id, timestamp, body);
  return new Request(`${base}/webhooks/resend`, {
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

/** Dispatch a request through the real router with a given env. */
async function route(req: Request, e: AppEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await createRouter(getConfig(e)).handle(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// --- setup ------------------------------------------------------------------

beforeEach(async () => {
  await resetDatabase();
  _clearKeyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
describe("send loop drives the real SES adapter", () => {
  it("sends one SigV4 request per recipient (maxBatch=1) and records the MessageId", async () => {
    await seedConfirmed("s1@integ.test");
    await seedConfirmed("s2@integ.test");
    const send = await dueSend();

    let n = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n += 1;
      return new Response(JSON.stringify({ MessageId: `ses-msg-${n}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await runSend(sesEnv(), send.id);

    expect(result.accepted).toBe(2);
    expect(result.finished).toBe(true);
    // maxBatch=1 → exactly one HTTP call per recipient, each SigV4-signed to SES.
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      const req = call[0] as Request;
      expect(req.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
      expect(req.headers.get("authorization") ?? "").toMatch(/^AWS4-HMAC-SHA256 /);
    }
    // provider_id (the SES MessageId) is persisted for later webhook matching.
    expect(await providerIdFor("s1@integ.test")).toMatch(/^ses-msg-/);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
  });
});

// ============================================================================
describe("send loop drives the real Resend adapter", () => {
  it("sends the whole audience in one batch (maxBatch=100) with Bearer + Idempotency-Key", async () => {
    await seedConfirmed("r1@integ.test");
    await seedConfirmed("r2@integ.test");
    await seedConfirmed("r3@integ.test");
    const send = await dueSend();

    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "re_a" }, { id: "re_b" }, { id: "re_c" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await runSend(resendEnv(), send.id);

    expect(result.accepted).toBe(3);
    expect(result.finished).toBe(true);
    // maxBatch=100 → the three recipients go in a single batch request.
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails/batch");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${RESEND_DEPLOY.RESEND_API_KEY}`);
    expect(headers["Idempotency-Key"]).toMatch(new RegExp(`^${send.id}-`));
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
  });
});

// ============================================================================
describe("webhook routes are wired through the real router", () => {
  it("POST /webhooks/ses (PROVIDER=ses): verified hard bounce suppresses via the route", async () => {
    await seedConfirmed("bounce@integ.test");
    const send = await dueSend();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ MessageId: "ses-live-1" }), { status: 200 }),
    );
    await runSend(sesEnv(), send.id);
    const providerId = (await providerIdFor("bounce@integ.test"))!;
    vi.restoreAllMocks();
    _clearKeyCache();

    // The SNS signature verification fetches the signing cert — serve our PEM.
    const signer = await makeSigner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = typeof input === "string" ? input : (input as Request).url;
      if (u === signer.certUrl) {
        return new Response(signer.certPem, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const envelope = await signedSnsBounce(signer, "bounce@integ.test", providerId);
    const req = new Request(`${base}/webhooks/ses`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(envelope),
    });

    const res = await route(req, sesEnv());

    expect(res.status).toBe(200);
    expect(await subscribers.isSuppressed(env.DB, "bounce@integ.test")).toBe(true);
    const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = ?")
      .bind(providerId)
      .first<{ event: string | null }>();
    expect(row?.event).toBe("bounced");
  });

  it("POST /webhooks/resend (PROVIDER=resend): a bounce webhook drops the address from the NEXT send (SPEC §10)", async () => {
    await seedConfirmed("victim@integ.test");
    const send1 = await dueSend();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "re_victim" }] }), { status: 200 }),
    );
    await runSend(resendEnv(), send1.id);
    expect(await providerIdFor("victim@integ.test")).toBe("re_victim");
    vi.restoreAllMocks();

    // Signed hard-bounce webhook through the real /webhooks/resend route.
    const req = await signedResendWebhook({
      type: "email.bounced",
      data: {
        email_id: "re_victim",
        to: ["victim@integ.test"],
        bounce: { type: "Permanent", message: "no such user" },
      },
    });
    const res = await route(req, resendEnv());
    expect(res.status).toBe(200);
    expect(await subscribers.isSuppressed(env.DB, "victim@integ.test")).toBe(true);

    // Next send: the suppressed address must not be materialized or mailed.
    const send2 = await dueSend();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result2 = await runSend(resendEnv(), send2.id);

    expect(result2.accepted).toBe(0);
    expect(spy).not.toHaveBeenCalled(); // no live recipients → no provider call
    const rollup = await sends.deliveryRollup(env.DB, send2.id);
    expect(rollup.accepted ?? 0).toBe(0);
    expect((await sends.getSend(env.DB, send2.id))!.status).toBe("sent");
  });

  it("both /webhooks/* routes are public (reach the adapter, never a 401/404)", async () => {
    // An unsigned body gets each adapter's own refusal, status and words, which only the
    // adapter can produce: a 404 would mean the route is gone, and a 401 that requireAuth
    // stopped it before the adapter ever parsed it.
    const sesRes = await route(
      new Request(`${base}/webhooks/ses`, { method: "POST", body: "{}" }),
      sesEnv(),
    );
    const resendRes = await route(
      new Request(`${base}/webhooks/resend`, { method: "POST", body: "{}" }),
      resendEnv(),
    );
    // SES: the envelope parses but carries no signature, so SNS verification refuses it.
    expect(sesRes.status).toBe(403);
    expect(await sesRes.text()).toBe("invalid signature");
    // Resend: no svix headers at all.
    expect(resendRes.status).toBe(400);
    expect(await resendRes.text()).toBe("missing signature headers");
  });
});
