import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { getProvider } from "../src/providers";
import { SesProvider } from "../src/providers/ses";
import { base64Bytes } from "../src/providers/ses_mime";
import { canonicalString, _clearKeyCache, type SnsEnvelope } from "../src/providers/sns";
import type { RenderedEmail } from "../src/providers/types";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import * as subscribers from "../src/db/subscribers";
import { UNSUB_SENTINEL } from "../src/render/render";

// --- fixtures ---------------------------------------------------------------

const ENDPOINT = "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails";

/** A minimal env carrying just the SES secrets the adapter reads. */
const sesEnv = {
  AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
  SES_CONFIGURATION_SET: "kestrel-events",
} as unknown as AppEnv;

function newProvider(): SesProvider {
  return new SesProvider(getConfig(env), sesEnv);
}

const UNSUB = "https://app.example.com/unsubscribe?token=deadbeef";

/** A rendered email still carrying the unsubscribe sentinel (as render() emits). */
function renderedFixture(): RenderedEmail {
  return {
    subject: "Weekly Update",
    html: `<html><body><p>Hello world, this is the newsletter body.</p><a href="${UNSUB_SENTINEL}">Unsubscribe</a></body></html>`,
    text: `Hello world, this is the newsletter body.\n\n—\nUnsubscribe: ${UNSUB_SENTINEL}\n`,
  };
}

const reqUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof Request ? input.url : String(input);

/** Decode one base64 MIME part (by media type) back to its original string. */
function decodeMimePart(mime: string, mediaType: string): string {
  const at = mime.indexOf(`Content-Type: ${mediaType}`);
  if (at < 0) throw new Error(`part not found: ${mediaType}`);
  const bodyStart = mime.indexOf("\r\n\r\n", at) + 4;
  const bodyEnd = mime.indexOf("\r\n--", bodyStart); // next boundary delimiter
  const b64 = mime.slice(bodyStart, bodyEnd).replace(/\r\n/g, "");
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- SNS signing helpers (local RSA keypair; no real AWS) --------------------

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
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

function wrap64(s: string): string {
  return (s.match(/.{1,64}/g) ?? []).join("\n");
}

interface Signer {
  privateKey: CryptoKey;
  certPem: string;
  certUrl: string;
}

/**
 * Generate an RSA keypair and wrap its public key (SPKI) in a minimal DER
 * certificate — enough structure for the adapter's SPKI extractor to find it —
 * served as PEM. A unique cert URL per signer sidesteps the adapter's key cache.
 */
async function makeSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const certDer = derSeq(derSeq(spki)); // Certificate ::= SEQ { TBS ::= SEQ { SPKI } }
  const certPem = `-----BEGIN CERTIFICATE-----\n${wrap64(base64Bytes(certDer))}\n-----END CERTIFICATE-----\n`;
  const certUrl = `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`;
  return { privateKey: pair.privateKey, certPem, certUrl };
}

async function signEnvelope(env0: SnsEnvelope, signer: Signer): Promise<SnsEnvelope> {
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    new TextEncoder().encode(canonicalString(env0)),
  );
  return { ...env0, Signature: base64Bytes(new Uint8Array(sig)) };
}

function webhookRequest(envelope: SnsEnvelope): Request {
  return new Request("https://kestrel.test/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: JSON.stringify(envelope),
  });
}

// --- setup ------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM suppressions"),
  ]);
  _clearKeyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
describe("SesProvider.sendBatch", () => {
  it("is a one-at-a-time, non-idempotent transport", () => {
    const provider = newProvider();
    expect(provider.name).toBe("ses");
    expect(provider.maxBatch).toBe(1);
    expect(provider.idempotentRetry).toBe(false);
  });

  it("POSTs a SigV4-signed Raw MIME message with per-recipient one-click headers", async () => {
    let captured: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      captured = input as Request;
      return new Response(JSON.stringify({ MessageId: "0100-msgid-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = newProvider();
    const results = await provider.sendBatch(renderedFixture(), [{ email: "reader@example.com", unsubscribeUrl: UNSUB }], {
      idempotencyKeyPrefix: "send-1",
    });

    // Response mapping: 200 → accepted with the SES MessageId as providerId.
    expect(results).toEqual([{ email: "reader@example.com", accepted: true, providerId: "0100-msgid-abc" }]);

    // Request shape.
    expect(captured).toBeDefined();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe(ENDPOINT);
    expect(captured!.headers.get("authorization") ?? "").toMatch(/^AWS4-HMAC-SHA256 /);

    const body = JSON.parse(await captured!.text());
    expect(body.Destination.ToAddresses).toEqual(["reader@example.com"]);
    expect(body.ConfigurationSetName).toBe("kestrel-events"); // events flow to SNS
    expect(body.FromEmailAddress).toContain("newsletter@news.example.com");

    // Content.Raw.Data is base64 of the raw MIME message.
    const mime = new TextDecoder().decode(Uint8Array.from(atob(body.Content.Raw.Data), (c) => c.charCodeAt(0)));
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="');
    expect(mime).toContain(`List-Unsubscribe: <${UNSUB}>`);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");

    // The sentinel is substituted per-recipient in BOTH parts, and the bodies survive.
    const html = decodeMimePart(mime, 'text/html; charset="utf-8"');
    const text = decodeMimePart(mime, 'text/plain; charset="utf-8"');
    expect(html).toContain("Hello world, this is the newsletter body.");
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html).not.toContain(UNSUB_SENTINEL);
    expect(text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(text).not.toContain(UNSUB_SENTINEL);
  });

  it("maps a 429 throttle to a retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ __type: "TooManyRequestsException", message: "Maximum sending rate exceeded." }), {
        status: 429,
      }),
    );
    const [r] = await newProvider().sendBatch(renderedFixture(), [{ email: "reader@example.com", unsubscribeUrl: UNSUB }], {
      idempotencyKeyPrefix: "send-1",
    });
    expect(r).toMatchObject({ email: "reader@example.com", accepted: false, retryable: true });
  });

  it("maps a permanent 400 (bad address) to a non-retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ __type: "BadRequestException", message: "Local address contains control or whitespace" }), {
        status: 400,
      }),
    );
    const [r] = await newProvider().sendBatch(renderedFixture(), [{ email: "bad addr@example.com", unsubscribeUrl: UNSUB }], {
      idempotencyKeyPrefix: "send-1",
    });
    expect(r).toMatchObject({ accepted: false, retryable: false });
  });

  it("maps a 5xx to a retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<internal>", { status: 500 }));
    const [r] = await newProvider().sendBatch(renderedFixture(), [{ email: "reader@example.com", unsubscribeUrl: UNSUB }], {
      idempotencyKeyPrefix: "send-1",
    });
    expect(r).toMatchObject({ accepted: false, retryable: true });
  });

  it("lets an ambiguous transport error throw (I4: no blind re-send)", async () => {
    // No HTTP response — SES may or may not have accepted. The adapter must not
    // swallow this into a retryable result; it propagates so the non-idempotent
    // send loop leaves the row dispatched for a human instead of re-sending.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    await expect(
      newProvider().sendBatch(renderedFixture(), [{ email: "reader@example.com", unsubscribeUrl: UNSUB }], {
        idempotencyKeyPrefix: "send-1",
      }),
    ).rejects.toThrow(/connection reset/);
  });
});

// ============================================================================
describe("getProvider factory", () => {
  it("returns the SES adapter when configured", () => {
    const provider = getProvider({ ...getConfig(env), provider: "ses" }, sesEnv);
    expect(provider).toBeInstanceOf(SesProvider);
    expect(provider.name).toBe("ses");
  });
});

// ============================================================================
describe("SesProvider.parseWebhook (SNS)", () => {
  async function seedDelivery(email: string, providerId: string): Promise<void> {
    const now = Date.now();
    // A real parent post + send: the deliveries FK is enforced in the test D1.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-ses','p-ses','sent',?,?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES ('s-ses','p-ses','sent',?, '', '', '', ?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO deliveries (id, send_id, email, status, provider_id, updated_at) VALUES (?, 's-ses', ?, 'accepted', ?, ?)",
    )
      .bind(`d-${providerId}`, email, providerId, now)
      .run();
  }

  function bounceMessage(email: string, providerId: string, bounceType: string): string {
    return JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: providerId, destination: [email] },
      bounce: {
        bounceType,
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: email, diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
      },
    });
  }

  function complaintMessage(email: string, providerId: string): string {
    return JSON.stringify({
      notificationType: "Complaint",
      mail: { messageId: providerId, destination: [email] },
      complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: email }] },
    });
  }

  function notification(signer: Signer, message: string): SnsEnvelope {
    return {
      Type: "Notification",
      MessageId: crypto.randomUUID(),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:kestrel-ses",
      Message: message,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: signer.certUrl,
    };
  }

  function mockCert(signer: Signer, extra?: (url: string) => Response | undefined) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = reqUrl(input);
      if (url === signer.certUrl) return new Response(signer.certPem, { status: 200 });
      const e = extra?.(url);
      if (e) return e;
      return new Response("not found", { status: 404 });
    });
  }

  it("verifies a hard-bounce notification and auto-suppresses the address", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("hardbounce@example.com", "msg-hard-1");

    const envelope = await signEnvelope(notification(signer, bounceMessage("hardbounce@example.com", "msg-hard-1", "Permanent")), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "bounced",
      hard: true,
      email: "hardbounce@example.com",
      providerId: "msg-hard-1",
    });

    const applied = await applyDeliveryEvents(env.DB, result.events);
    expect(applied.suppressed).toBe(1);
    expect(await subscribers.isSuppressed(env.DB, "hardbounce@example.com")).toBe(true);

    const row = await env.DB.prepare("SELECT event FROM deliveries WHERE provider_id = 'msg-hard-1'").first<{ event: string }>();
    expect(row?.event).toBe("bounced");
  });

  it("verifies a complaint notification and auto-suppresses the address", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("complainer@example.com", "msg-cmp-1");

    const envelope = await signEnvelope(notification(signer, complaintMessage("complainer@example.com", "msg-cmp-1")), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.events[0]).toMatchObject({ type: "complained", email: "complainer@example.com" });
    const applied = await applyDeliveryEvents(env.DB, result.events);
    expect(applied.suppressed).toBe(1);
    expect(await subscribers.isSuppressed(env.DB, "complainer@example.com")).toBe(true);
  });

  it("records a transient (soft) bounce WITHOUT suppressing", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("softbounce@example.com", "msg-soft-1");

    const envelope = await signEnvelope(notification(signer, bounceMessage("softbounce@example.com", "msg-soft-1", "Transient")), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.events[0]).toMatchObject({ type: "bounced", hard: false });
    const applied = await applyDeliveryEvents(env.DB, result.events);
    expect(applied.suppressed).toBe(0);
    expect(await subscribers.isSuppressed(env.DB, "softbounce@example.com")).toBe(false);
  });

  it("confirms an SNS subscription by GETting the SubscribeURL", async () => {
    const signer = await makeSigner();
    const subscribeUrl = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=${crypto.randomUUID()}`;
    let subscribeFetched = false;
    const spy = mockCert(signer, (url) => {
      if (url === subscribeUrl) {
        subscribeFetched = true;
        return new Response("<ConfirmSubscriptionResponse/>", { status: 200 });
      }
      return undefined;
    });

    const base: SnsEnvelope = {
      Type: "SubscriptionConfirmation",
      MessageId: crypto.randomUUID(),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:kestrel-ses",
      Message: "You have chosen to subscribe to the topic.",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: signer.certUrl,
      SubscribeURL: subscribeUrl,
      Token: "a-token",
    };
    const envelope = await signEnvelope(base, signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toHaveLength(0);
    expect(subscribeFetched).toBe(true);
    expect(spy.mock.calls.some((c) => reqUrl(c[0]) === subscribeUrl)).toBe(true);
  });

  it("rejects a forged signature and mutates nothing", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("victim@example.com", "msg-forged-1");

    const good = await signEnvelope(notification(signer, bounceMessage("victim@example.com", "msg-forged-1", "Permanent")), signer);
    // Tamper: keep everything, corrupt the signature.
    const forged: SnsEnvelope = { ...good, Signature: base64Bytes(new Uint8Array(256)) };

    const result = await newProvider().parseWebhook(webhookRequest(forged), sesEnv);

    expect(result.response.status).toBe(403);
    expect(result.events).toHaveLength(0);
    expect(await subscribers.isSuppressed(env.DB, "victim@example.com")).toBe(false);
  });

  it("rejects a signing cert served from an untrusted host", async () => {
    const signer = await makeSigner();
    // The message points its SigningCertURL at a non-SNS host.
    signer.certUrl = "https://evil.example.com/cert.pem";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(signer.certPem, { status: 200 }));

    const envelope = await signEnvelope(notification(signer, bounceMessage("x@example.com", "msg-x", "Permanent")), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(403);
    expect(result.events).toHaveLength(0);
    // Host is rejected before any fetch of the cert.
    expect(spy.mock.calls.some((c) => reqUrl(c[0]) === "https://evil.example.com/cert.pem")).toBe(false);
  });

  it("rejects an unparseable body with 400", async () => {
    const result = await newProvider().parseWebhook(
      new Request("https://kestrel.test/webhooks/ses", { method: "POST", body: "not json" }),
      sesEnv,
    );
    expect(result.response.status).toBe(400);
    expect(result.events).toHaveLength(0);
  });
});
