/**
 * End-to-end delivery integration (pre-live confidence check).
 *
 * The adapter spec (`provider_ses`) exercises the adapter in isolation. This spec instead drives the REAL wiring that a live run hits,
 * with only the outbound network mocked:
 *
 *   - the send loop (`runSend`) selecting the configured provider via `getConfig`
 *     + `getProvider`, chunking to `maxBatch`, and recording `provider_id`;
 *   - the actual router (`createRouter(config).handle`) dispatching `POST /webhooks/*`
 *     to that same provider and applying the normalized events;
 *   - the full loop: send -> provider id recorded -> signed webhook bounce ->
 *     suppression -> the address is dropped from the NEXT send's audience (SPEC §7, §10).
 *
 * PROVIDER is set per test by passing an env override to `runSend` / `handle` (both
 * resolve config from env), so this proves the factory wires `ses` and its webhook route
 * is live and public. No real credentials or network: SES send and cert fetches are
 * mocked; SNS payloads are signed locally.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import * as sends from "../src/db/sends";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { _clearKeyCache, type SnsEnvelope } from "../src/providers/sns";
import { runSend } from "../src/send/loop";
import { SES_DEPLOY, SNS_TOPIC_ARN } from "./support/deploy";
import { dueSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { base } from "./support/http";
import { answerSes, SES_BULK_ENDPOINT } from "./support/ses";
import { makeSigner, type Signer, signEnvelope } from "./support/sns";

// --- env overrides ----------------------------------------------------------

// The deploy constants carry the credentials; the configuration set is what routes SES's
// events to the SNS topic in a real deploy, so a send names it.
const sesEnv = () =>
  ({ ...env, ...SES_DEPLOY, SES_CONFIGURATION_SET: "kestrel-events" }) as unknown as AppEnv;

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
  it("sends the batch as one SigV4-signed SendBulkEmail and records each MessageId", async () => {
    await seedConfirmed("s1@integ.test");
    await seedConfirmed("s2@integ.test");
    const send = await dueSend();

    let n = 0;
    const { spy, requests } = answerSes(() => {
      n += 1;
      return { Status: "SUCCESS", MessageId: `ses-msg-${n}` };
    });

    const result = await runSend(sesEnv(), send.id);

    expect(result.accepted).toBe(2);
    expect(result.finished).toBe(true);
    // Both recipients fit one request (a batch is the account's send rate, up to 50).
    expect(spy).toHaveBeenCalledTimes(1);
    const req = spy.mock.calls[0]![0] as Request;
    expect(req.url).toBe(SES_BULK_ENDPOINT);
    expect(req.headers.get("authorization") ?? "").toMatch(/^AWS4-HMAC-SHA256 /);
    expect(requests[0]!.BulkEmailEntries).toHaveLength(2);
    // provider_id (the SES MessageId) is persisted for later webhook matching.
    expect(await providerIdFor("s1@integ.test")).toMatch(/^ses-msg-/);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
  });

  it("a configuration set SES can't find holds the send with nobody consumed, never marking the list unsent (SPEC §12)", async () => {
    await seedConfirmed("s1@integ.test");
    await seedConfirmed("s2@integ.test");
    const send = await dueSend();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          __type: "NotFoundException",
          message: "Configuration set <kestrel-events> does not exist.",
        }),
        { status: 404 },
      ),
    );

    const result = await runSend(sesEnv(), send.id);

    expect(result).toMatchObject({ accepted: 0, unsent: 0, finished: false, halt: "account" });
    expect(spy).toHaveBeenCalledTimes(1);
    const row = await sends.getSend(env.DB, send.id);
    expect(row).toMatchObject({
      status: "sending",
      halt_reason: "account",
      halt_cause: "configuration",
      c_pending: 2,
      c_in_flight: 0,
      c_unsent: 0,
    });
  });
});

// ============================================================================
describe("webhook routes are wired through the real router", () => {
  it("POST /webhooks/ses: a verified hard bounce suppresses the address, and the NEXT send leaves it out (SPEC §10)", async () => {
    await seedConfirmed("bounce@integ.test");
    const send = await dueSend();
    answerSes(() => ({ Status: "SUCCESS", MessageId: "ses-live-1" }));
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

    // Next send: the suppressed address must not be materialized or mailed.
    vi.restoreAllMocks();
    const send2 = await dueSend();
    const { spy } = answerSes();
    const result2 = await runSend(sesEnv(), send2.id);

    expect(result2.accepted).toBe(0);
    expect(spy).not.toHaveBeenCalled(); // no live recipients → no provider call
    const rollup = await sends.deliveryRollup(env.DB, send2.id);
    expect(rollup.accepted ?? 0).toBe(0);
    expect((await sends.getSend(env.DB, send2.id))!.status).toBe("sent");
  });

  it("the webhook route is public (reaches the adapter, never a 401/404)", async () => {
    // An unsigned body gets the adapter's own refusal, status and words, which only the
    // adapter can produce: a 404 would mean the route is gone, and a 401 that requireAuth
    // stopped it before the adapter ever parsed it.
    const sesRes = await route(
      new Request(`${base}/webhooks/ses`, { method: "POST", body: "{}" }),
      sesEnv(),
    );
    // SES: the envelope parses but carries no signature, so SNS verification refuses it.
    expect(sesRes.status).toBe(403);
    expect(await sesRes.text()).toBe("invalid signature");
  });
});
