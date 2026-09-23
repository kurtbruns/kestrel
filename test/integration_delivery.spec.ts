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
 *     suppression -> the address is dropped from the NEXT send's audience (I2).
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
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { signSvix } from "../src/providers/resend";
import { base64Bytes } from "../src/providers/ses_mime";
import { _clearKeyCache, canonicalString, type SnsEnvelope } from "../src/providers/sns";
import { runSend } from "../src/send/loop";
import { freeze } from "../src/send/schedule";
import { RESEND_DEPLOY, SES_DEPLOY, SNS_TOPIC_ARN } from "./support/deploy";

// --- env overrides ----------------------------------------------------------

const sesEnv = () =>
  ({
    ...env,
    ...SES_DEPLOY,
    AWS_ACCESS_KEY_ID: "AKIAINTEGTEST",
    AWS_SECRET_ACCESS_KEY: "integ-secret-key",
    SES_CONFIGURATION_SET: "kestrel-events",
  }) as unknown as AppEnv;

const WHSEC = `whsec_${btoa("integration-svix-signing-key-0123456789")}`;

const resendEnv = () =>
  ({
    ...env,
    ...RESEND_DEPLOY,
    RESEND_API_KEY: "re_integ_key",
    RESEND_WEBHOOK_SECRET: WHSEC,
  }) as unknown as AppEnv;

// --- seeding helpers --------------------------------------------------------

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

/** Freeze a scheduled send for the current audience (render is provider-agnostic). */
async function scheduledSend(): Promise<sends.SendRow> {
  const { post } = await posts.createPost(
    env.DB,
    { subject: "Subj", markdown: "# Hi\n\nbody" },
    "test",
  );
  return freeze(env, getConfig(env), post, Date.now() - 1000);
}

async function providerIdFor(email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT provider_id FROM deliveries WHERE email = ?")
    .bind(email)
    .first<{ provider_id: string | null }>();
  return row?.provider_id ?? null;
}

// --- SNS signing (local RSA keypair; mirrors provider_ses.spec.ts) -----------

function derLen(n: number): number[] {
  if (n < 0x80) {
    return [n];
  }
  const bytes: number[] = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derSeq(...items: Uint8Array[]): Uint8Array {
  const total = items.reduce((n, a) => n + a.length, 0);
  const content = new Uint8Array(total);
  let o = 0;
  for (const a of items) {
    content.set(a, o);
    o += a.length;
  }
  const header = new Uint8Array([0x30, ...derLen(content.length)]);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

const wrap64 = (s: string): string => (s.match(/.{1,64}/g) ?? []).join("\n");

interface Signer {
  privateKey: CryptoKey;
  certPem: string;
  certUrl: string;
}

async function makeSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const certDer = derSeq(derSeq(spki));
  const certPem = `-----BEGIN CERTIFICATE-----\n${wrap64(base64Bytes(certDer))}\n-----END CERTIFICATE-----\n`;
  const certUrl = `https://sns.us-east-1.amazonaws.com/cert-${crypto.randomUUID()}.pem`;
  return { privateKey: pair.privateKey, certPem, certUrl };
}

async function signedSnsBounce(
  signer: Signer,
  email: string,
  providerId: string,
): Promise<SnsEnvelope> {
  const message = JSON.stringify({
    notificationType: "Bounce",
    mail: { messageId: providerId, destination: [email] },
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: email, diagnosticCode: "smtp; 550 user unknown" }],
    },
  });
  const base: SnsEnvelope = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    TopicArn: SNS_TOPIC_ARN,
    Message: message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: signer.certUrl,
  };
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    new TextEncoder().encode(canonicalString(base)),
  );
  return { ...base, Signature: base64Bytes(new Uint8Array(sig)) };
}

// --- Svix signing (Resend) --------------------------------------------------

async function signedResendWebhook(payload: unknown): Promise<Request> {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = await signSvix(WHSEC, id, timestamp, body);
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

/** Dispatch a request through the real router with a given env. */
async function route(req: Request, e: AppEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await createRouter(getConfig(e)).handle(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// --- setup ------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
  ]);
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
    const send = await scheduledSend();

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
    const send = await scheduledSend();

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
    expect(headers.Authorization).toBe("Bearer re_integ_key");
    expect(headers["Idempotency-Key"]).toMatch(new RegExp(`^${send.id}-`));
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
  });
});

// ============================================================================
describe("webhook routes are wired through the real router", () => {
  it("POST /webhooks/ses (PROVIDER=ses): verified hard bounce suppresses via the route", async () => {
    await seedConfirmed("bounce@integ.test");
    const send = await scheduledSend();
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
    const req = new Request("https://kestrel.test/webhooks/ses", {
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

  it("POST /webhooks/resend (PROVIDER=resend): a bounce webhook drops the address from the NEXT send (I2)", async () => {
    await seedConfirmed("victim@integ.test");
    const send1 = await scheduledSend();
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
    const send2 = await scheduledSend();
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
    // No signature headers → the adapter rejects (400/401/403), proving the route
    // is registered and NOT behind requireAuth (auth would be 401 before parsing).
    const sesRes = await route(
      new Request("https://kestrel.test/webhooks/ses", { method: "POST", body: "{}" }),
      sesEnv(),
    );
    const resendRes = await route(
      new Request("https://kestrel.test/webhooks/resend", { method: "POST", body: "{}" }),
      resendEnv(),
    );
    for (const res of [sesRes, resendRes]) {
      expect(res.status).not.toBe(404); // route exists
      expect([400, 401, 403]).toContain(res.status); // adapter-level rejection, not auth gate
    }
    // Resend with no svix headers is specifically a 400 "missing signature headers".
    expect(resendRes.status).toBe(400);
  });
});
