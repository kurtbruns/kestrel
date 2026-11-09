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
import { updateSettings } from "../src/db/settings";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { _clearKeyCache, type SnsEnvelope } from "../src/providers/sns";
import { runSend } from "../src/send/loop";
import { SES_DEPLOY, SNS_TOPIC_ARN } from "./support/deploy";
import { dueSend, resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { base } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { answerSes, SES_BULK_ENDPOINT } from "./support/ses";
import { makeSigner, type Signer, signEnvelope } from "./support/sns";

// --- env overrides ----------------------------------------------------------

// The deploy constants carry the credentials; the configuration set is what routes SES's
// events to the SNS topic in a real deploy, so a send names it.
const sesEnv = () =>
  ({ ...env, ...SES_DEPLOY, SES_CONFIGURATION_SET: "kestrel-events" }) as unknown as AppEnv;
// The same deploy on a bare From address, so the sender's name is the publication's (SPEC §9).
const bareSes = () =>
  ({ ...sesEnv(), FROM_ADDRESS: "news@send.birds.example" }) as unknown as AppEnv;

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

describe("SES's answers, read by whose problem they are (SPEC §12)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const notVerified = (to: string) => ({
    Status: "MESSAGE_REJECTED",
    Error: `Email address is not verified. The following identities failed the check in region US-EAST-1: ${to}`,
  });

  /** Move the clock to the send's next retry. */
  async function toRetry(sendId: string): Promise<void> {
    const row = await sends.getSend(env.DB, sendId);
    vi.setSystemTime(row!.halt_retry_at!);
  }

  it("holds a send the sandbox refuses, marks no one unsent, and mails each reader once after production access (I4)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const email of ["verified@integ.test", "a@integ.test", "b@integ.test"]) {
      await seedConfirmed(email);
    }
    const send = await dueSend();
    const sandbox = answerSes((to) =>
      to === "verified@integ.test" ? { Status: "SUCCESS", MessageId: "m-v" } : notVerified(to),
    );

    const held = await runSend(sesEnv(), send.id);

    expect(held).toMatchObject({ accepted: 1, unsent: 0, finished: false, halt: "account" });
    expect(await sends.getSend(env.DB, send.id)).toMatchObject({
      status: "sending",
      halt_reason: "account",
      halt_cause: "sandbox",
      c_accepted: 1,
      c_pending: 2,
      c_unsent: 0,
    });
    sandbox.spy.mockRestore();

    // AWS grants production access: the next retry takes the rest, and the reader SES
    // already took is never in a request again.
    await toRetry(send.id);
    const granted = answerSes();
    const resumed = await runSend(sesEnv(), send.id);

    expect(resumed).toMatchObject({ accepted: 2, unsent: 0, finished: true });
    expect(
      granted.requests.flatMap((q) => q.BulkEmailEntries.map((e) => e.Destination.ToAddresses[0])),
    ).toEqual(["a@integ.test", "b@integ.test"]);
    expect(await sends.getSend(env.DB, send.id)).toMatchObject({ status: "sent", c_unsent: 0 });
  });

  it("leaves a batch SES answered with a server error in flight for Resolve, never re-sending it (I4)", async () => {
    allowErrorLogs("send.ambiguous");
    await seedConfirmed("s1@integ.test");
    await seedConfirmed("s2@integ.test");
    const send = await dueSend();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ __type: "InternalFailure", message: "oops" }), { status: 500 }),
    );

    const result = await runSend(sesEnv(), send.id);

    expect(result).toMatchObject({ accepted: 0, unsent: 0, finished: false, halt: "unavailable" });
    expect(await sends.getSend(env.DB, send.id)).toMatchObject({
      c_in_flight: 2,
      c_pending: 0,
      c_unsent: 0,
      halt_cause: "outage",
    });
  });

  it("holds a send whose email SES refuses without holding another send behind it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedConfirmed("s1@integ.test");
    await seedConfirmed("s2@integ.test");
    const refused = await dueSend();
    const rejecting = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ __type: "MessageRejected", message: "Bad content" }), {
        status: 400,
      }),
    );
    expect(await runSend(sesEnv(), refused.id)).toMatchObject({
      accepted: 0,
      unsent: 0,
      halt: "account",
    });
    expect(await sends.getSend(env.DB, refused.id)).toMatchObject({
      halt_cause: "content",
      c_pending: 2,
      c_unsent: 0,
    });
    rejecting.mockRestore();

    // Another post's send, while the refusal stands, asks SES and goes out.
    const other = await dueSend();
    answerSes();
    expect(await runSend(sesEnv(), other.id)).toMatchObject({ accepted: 2, finished: true });
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

// ============================================================================
// The From line a list send carries (SPEC §9, I5): the name frozen with its render, so what
// goes out is what the publisher reviewed, whatever the publication is called since.
describe("the From line a list send carries", () => {
  const fromOf = (requests: { FromEmailAddress: string }[]) => requests[0]!.FromEmailAddress;

  it("goes out under the name frozen at schedule, not the publication's name since (I5)", async () => {
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    await seedConfirmed("s1@integ.test");
    const send = await dueSend();
    // A rename that reaches no re-make, as one made while the send was already going out.
    await updateSettings(env.DB, { publication: { name: "Renamed" } });
    const { requests } = answerSes();
    await runSend(bareSes(), send.id);
    expect(fromOf(requests)).toBe("Field Notes <news@send.birds.example>");
  });

  it("goes out with no display name when the publication had none at schedule", async () => {
    await seedConfirmed("s1@integ.test");
    const send = await dueSend();
    const { requests } = answerSes();
    await runSend(bareSes(), send.id);
    expect(fromOf(requests)).toBe("news@send.birds.example");
  });

  it("a send frozen before the name was kept goes out under the rule as it stands when it fires", async () => {
    await seedConfirmed("s1@integ.test");
    const send = await dueSend();
    await env.DB.prepare("UPDATE sends SET from_name = NULL WHERE id = ?").bind(send.id).run();
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    const { requests } = answerSes();
    await runSend(bareSes(), send.id);
    expect(fromOf(requests)).toBe("Field Notes <news@send.birds.example>");
  });

  it("quotes a frozen name a comma would otherwise split, so SES takes the request", async () => {
    await updateSettings(env.DB, { publication: { name: "Smith, Jane" } });
    await seedConfirmed("s1@integ.test");
    const send = await dueSend();
    const { requests } = answerSes();
    const result = await runSend(bareSes(), send.id);
    expect(result.accepted).toBe(1);
    expect(fromOf(requests)).toBe('"Smith, Jane" <news@send.birds.example>');
  });
});

// ============================================================================
// The From line a subscribe confirmation carries (SPEC §9): the rule as it stands, through
// the real adapter, so a reader's first email comes from the same sender as every other.
describe("the From line a confirmation carries", () => {
  const signup = (e: AppEnv) =>
    route(
      new Request(`${base}/subscribe`, {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "email=new@integ.test",
      }),
      e,
    );

  it("goes out under the publication's name over a bare From address", async () => {
    await sendingWorks();
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    const { requests } = answerSes();
    expect((await signup(bareSes())).status).toBe(200);
    expect(requests.map((r) => r.endpoint)).toEqual(["single"]);
    expect(requests[0]!.FromEmailAddress).toBe("Field Notes <news@send.birds.example>");
  });

  it("goes out under a name written into the From address, whatever the publication is called", async () => {
    await sendingWorks();
    await updateSettings(env.DB, { publication: { name: "Field Notes" } });
    const { requests } = answerSes();
    expect((await signup(sesEnv())).status).toBe(200);
    expect(requests[0]!.FromEmailAddress).toBe("Birds <news@send.birds.example>");
  });
});
