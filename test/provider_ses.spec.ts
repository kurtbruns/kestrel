import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { getProvider } from "../src/providers";
import { SesProvider } from "../src/providers/ses";
import { base64Bytes } from "../src/providers/ses_mime";
import { _clearKeyCache, canonicalString, isSnsHost, type SnsEnvelope } from "../src/providers/sns";
import type { RenderedEmail } from "../src/providers/types";
import { UNSUB_SENTINEL } from "../src/render/render";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { SNS_TOPIC_ARN } from "./support/deploy";

// --- fixtures ---------------------------------------------------------------

const ENDPOINT = "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails";

/** A minimal env carrying just the SES secrets the adapter reads. */
const sesEnv = {
  AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
  SES_CONFIGURATION_SET: "kestrel-events",
  SNS_TOPIC_ARN,
} as unknown as AppEnv;

/** A topic in someone else's account: SNS signs its messages just as validly. */
const FOREIGN_TOPIC_ARN = "arn:aws:sns:us-east-1:999999999999:not-ours";

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
  if (at < 0) {
    throw new Error(`part not found: ${mediaType}`);
  }
  const bodyStart = mime.indexOf("\r\n\r\n", at) + 4;
  const bodyEnd = mime.indexOf("\r\n--", bodyStart); // next boundary delimiter
  const b64 = mime.slice(bodyStart, bodyEnd).replace(/\r\n/g, "");
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- SNS signing helpers (local RSA keypair; no real AWS) --------------------

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
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
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
    const results = await provider.sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      {
        idempotencyKeyPrefix: "send-1",
      },
    );

    // Response mapping: 200 → accepted with the SES MessageId as providerId.
    expect(results).toEqual({
      kind: "answered",
      results: [{ email: "reader@example.com", accepted: true, providerId: "0100-msgid-abc" }],
    });

    // Request shape.
    expect(captured).toBeDefined();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe(ENDPOINT);
    expect(captured!.headers.get("authorization") ?? "").toMatch(/^AWS4-HMAC-SHA256 /);

    const body = JSON.parse(await captured!.text());
    expect(body.Destination.ToAddresses).toEqual(["reader@example.com"]);
    expect(body.ConfigurationSetName).toBe("kestrel-events"); // events flow to SNS
    expect(body.FromEmailAddress).toContain("newsletter@send.example.com");

    // Content.Raw.Data is base64 of the raw MIME message.
    const mime = new TextDecoder().decode(
      Uint8Array.from(atob(body.Content.Raw.Data), (c) => c.charCodeAt(0)),
    );
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

  // SES reports its daily quota and its per-second rate as the same throttle; only the
  // message tells a day's wait from a second's.
  it.each([
    [
      "the daily quota",
      { __type: "TooManyRequestsException", message: "Daily message quota exceeded." },
      { reason: "account", cause: "quota" },
    ],
    [
      "the sending rate",
      { __type: "TooManyRequestsException", message: "Maximum sending rate exceeded." },
      { reason: "unavailable", cause: "rate_limit" },
    ],
    ["a bare 429", {}, { reason: "unavailable", cause: "rate_limit" }],
  ])("halts a 429 on %s", async (_label, body, halt) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 429 }),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      { idempotencyKeyPrefix: "send-1" },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { ...halt, mayHaveSent: false } });
  });

  it("maps a permanent 400 (bad address) to a non-retryable failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          __type: "BadRequestException",
          message: "Local address contains control or whitespace",
        }),
        {
          status: 400,
        },
      ),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "bad addr@example.com", unsubscribeUrl: UNSUB }],
      {
        idempotencyKeyPrefix: "send-1",
      },
    );
    expect(r).toMatchObject({
      kind: "answered",
      results: [{ accepted: false, retryable: false }],
    });
  });

  it("halts a 5xx as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<internal>", { status: 500 }));
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      {
        idempotencyKeyPrefix: "send-1",
      },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { reason: "unavailable" } });
  });

  it.each([
    [400, "SendingPausedException", "Account is paused", "suspended"],
    [400, "AccountSuspendedException", "Account is suspended", "suspended"],
    [400, "MailFromDomainNotVerifiedException", "MAIL FROM domain is not verified", "sender"],
    [403, "UnrecognizedClientException", "The token included is invalid", "credentials"],
  ])(
    "halts a %i %s as an account refusal, carrying SES's words",
    async (status, type, message, cause) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ __type: type, message }), { status }),
      );
      const r = await newProvider().sendBatch(
        renderedFixture(),
        [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
        { idempotencyKeyPrefix: "send-1" },
      );
      expect(r).toEqual({
        kind: "halted",
        halt: {
          reason: "account",
          cause,
          error: `ses ${status} ${type}: ${message}`,
          mayHaveSent: false,
        },
      });
    },
  );

  it("reads the error type from the x-amzn-ErrorType header when the body carries none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Account is paused" }), {
        status: 400,
        headers: {
          "x-amzn-ErrorType":
            "SendingPausedException:http://internal.amazon.com/coral/com.amazon.sesv2/",
        },
      }),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      { idempotencyKeyPrefix: "send-1" },
    );
    expect(r).toMatchObject({
      kind: "halted",
      halt: {
        reason: "account",
        cause: "suspended",
        error: "ses 400 SendingPausedException: Account is paused",
      },
    });
  });

  it("halts a MessageRejected naming the sender's own identity, but not one naming only the recipient", async () => {
    const rejected = (message: string) =>
      new Response(JSON.stringify({ __type: "MessageRejected", message }), { status: 400 });
    const from = "newsletter@send.example.com";
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        rejected(
          `Email address is not verified. The following identities failed the check in region US-EAST-1: ${from}`,
        ),
      )
      .mockResolvedValueOnce(
        rejected(
          "Email address is not verified. The following identities failed the check in region US-EAST-1: reader@example.com",
        ),
      );
    const one = [{ email: "reader@example.com", unsubscribeUrl: UNSUB }];
    expect(
      await newProvider().sendBatch(renderedFixture(), one, { idempotencyKeyPrefix: "s" }),
    ).toMatchObject({
      kind: "halted",
      halt: { reason: "account", cause: "sender" },
    });
    expect(
      await newProvider().sendBatch(renderedFixture(), one, { idempotencyKeyPrefix: "s" }),
    ).toMatchObject({
      kind: "answered",
      results: [{ accepted: false, retryable: false }],
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("lets an ambiguous transport error throw (I4: no blind re-send)", async () => {
    // No HTTP response — SES may or may not have accepted. The adapter must not
    // swallow this into a retryable result; it propagates so the non-idempotent
    // send loop leaves the row dispatched for a human instead of re-sending.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    await expect(
      newProvider().sendBatch(
        renderedFixture(),
        [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
        {
          idempotencyKeyPrefix: "send-1",
        },
      ),
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
        bouncedRecipients: [
          { emailAddress: email, diagnosticCode: "smtp; 550 5.1.1 user unknown" },
        ],
      },
    });
  }

  function complaintMessage(email: string, providerId: string): string {
    return JSON.stringify({
      notificationType: "Complaint",
      mail: { messageId: providerId, destination: [email] },
      complaint: {
        complaintFeedbackType: "abuse",
        complainedRecipients: [{ emailAddress: email }],
      },
    });
  }

  function notification(signer: Signer, message: string, topicArn = SNS_TOPIC_ARN): SnsEnvelope {
    return {
      Type: "Notification",
      MessageId: crypto.randomUUID(),
      TopicArn: topicArn,
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
      if (url === signer.certUrl) {
        return new Response(signer.certPem, { status: 200 });
      }
      const e = extra?.(url);
      if (e) {
        return e;
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("verifies a hard-bounce notification and auto-suppresses the address", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("hardbounce@example.com", "msg-hard-1");

    const envelope = await signEnvelope(
      notification(signer, bounceMessage("hardbounce@example.com", "msg-hard-1", "Permanent")),
      signer,
    );
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

    const row = await env.DB.prepare(
      "SELECT event FROM deliveries WHERE provider_id = 'msg-hard-1'",
    ).first<{ event: string }>();
    expect(row?.event).toBe("bounced");
  });

  it("verifies a complaint notification and auto-suppresses the address", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("complainer@example.com", "msg-cmp-1");

    const envelope = await signEnvelope(
      notification(signer, complaintMessage("complainer@example.com", "msg-cmp-1")),
      signer,
    );
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

    const envelope = await signEnvelope(
      notification(signer, bounceMessage("softbounce@example.com", "msg-soft-1", "Transient")),
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.events[0]).toMatchObject({ type: "bounced", hard: false });
    const applied = await applyDeliveryEvents(env.DB, result.events);
    expect(applied.suppressed).toBe(0);
    expect(await subscribers.isSuppressed(env.DB, "softbounce@example.com")).toBe(false);
  });

  function subscriptionConfirmation(
    signer: Signer,
    subscribeUrl: string,
    topicArn = SNS_TOPIC_ARN,
  ): SnsEnvelope {
    return {
      Type: "SubscriptionConfirmation",
      MessageId: crypto.randomUUID(),
      TopicArn: topicArn,
      Message: "You have chosen to subscribe to the topic.",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: signer.certUrl,
      SubscribeURL: subscribeUrl,
      Token: "a-token",
    };
  }

  /** Mock the cert, and record whether the SubscribeURL was fetched. */
  function mockSubscribe(signer: Signer, subscribeUrl: string) {
    const fetched = { subscribe: false };
    const spy = mockCert(signer, (url) => {
      if (url === subscribeUrl) {
        fetched.subscribe = true;
        return new Response("<ConfirmSubscriptionResponse/>", { status: 200 });
      }
      return undefined;
    });
    return { spy, fetched };
  }

  const newSubscribeUrl = () =>
    `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=${crypto.randomUUID()}`;

  it("confirms an SNS subscription by GETting the SubscribeURL", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    const { spy, fetched } = mockSubscribe(signer, subscribeUrl);

    const envelope = await signEnvelope(subscriptionConfirmation(signer, subscribeUrl), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toHaveLength(0);
    expect(fetched.subscribe).toBe(true);
    expect(spy.mock.calls.some((c) => reqUrl(c[0]) === subscribeUrl)).toBe(true);
  });

  // A valid SNS signature proves only that SNS sent the message; any AWS account's topic
  // could have. The configured topic is what makes it this deployment's.
  it("refuses a correctly signed subscription from another topic, never fetching its SubscribeURL", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    const { fetched } = mockSubscribe(signer, subscribeUrl);

    const envelope = await signEnvelope(
      subscriptionConfirmation(signer, subscribeUrl, FOREIGN_TOPIC_ARN),
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(403);
    expect(result.events).toHaveLength(0);
    expect(fetched.subscribe).toBe(false);
  });

  it("refuses a correctly signed bounce from another topic and suppresses no one", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("listed@example.com", "msg-foreign-1");

    const envelope = await signEnvelope(
      notification(
        signer,
        bounceMessage("listed@example.com", "msg-foreign-1", "Permanent"),
        FOREIGN_TOPIC_ARN,
      ),
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(403);
    expect(result.events).toHaveLength(0);
    expect(await subscribers.isSuppressed(env.DB, "listed@example.com")).toBe(false);
  });

  it("refuses everything when SNS_TOPIC_ARN is unset (fails closed)", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    const { fetched } = mockSubscribe(signer, subscribeUrl);
    const unset = { ...sesEnv, SNS_TOPIC_ARN: undefined } as unknown as AppEnv;

    const confirm = await signEnvelope(subscriptionConfirmation(signer, subscribeUrl), signer);
    const bounce = await signEnvelope(
      notification(signer, bounceMessage("a@example.com", "msg-unset-1", "Permanent")),
      signer,
    );
    for (const envelope of [confirm, bounce]) {
      const result = await newProvider().parseWebhook(webhookRequest(envelope), unset);
      expect(result.response.status).toBe(403);
      expect(result.events).toHaveLength(0);
    }
    expect(fetched.subscribe).toBe(false);
  });

  it("rejects a forged signature and mutates nothing", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("victim@example.com", "msg-forged-1");

    const good = await signEnvelope(
      notification(signer, bounceMessage("victim@example.com", "msg-forged-1", "Permanent")),
      signer,
    );
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
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(signer.certPem, { status: 200 }));

    const envelope = await signEnvelope(
      notification(signer, bounceMessage("x@example.com", "msg-x", "Permanent")),
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(403);
    expect(result.events).toHaveLength(0);
    // Host is rejected before any fetch of the cert.
    expect(spy.mock.calls.some((c) => reqUrl(c[0]) === "https://evil.example.com/cert.pem")).toBe(
      false,
    );
  });

  it("pins the signing-cert host to AWS's SNS endpoint pattern", () => {
    expect(isSnsHost("sns.us-east-1.amazonaws.com")).toBe(true);
    expect(isSnsHost("sns.cn-north-1.amazonaws.com.cn")).toBe(true);
    expect(isSnsHost("SNS.EU-WEST-1.AMAZONAWS.COM")).toBe(true);
    // Shapes the old prefix/suffix check let through.
    expect(isSnsHost("sns.evil.example.amazonaws.com")).toBe(false);
    expect(isSnsHost("sns..amazonaws.com")).toBe(false);
    expect(isSnsHost("sns.us-east-1.amazonaws.com.evil.example")).toBe(false);
    expect(isSnsHost("notsns.us-east-1.amazonaws.com")).toBe(false);
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
