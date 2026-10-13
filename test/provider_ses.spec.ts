import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as subscribers from "../src/db/subscribers";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { getProvider } from "../src/providers";
import { SesProvider } from "../src/providers/ses";
import { _clearKeyCache, isSnsHost, type SnsEnvelope } from "../src/providers/sns";
import { PROVIDER_REQUEST_TIMEOUT_MS, type RenderedEmail } from "../src/providers/types";
import { SENTTO_SENTINEL, substituteRecipient, UNSUB_SENTINEL } from "../src/render/render";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { SNS_TOPIC_ARN } from "./support/deploy";
import { deliveryEvent, dueSend, resetDatabase, seedDelivery } from "./support/fixtures";
import { base } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { neverAnswers } from "./support/provider_timeout";
import { answerSes, deliveredBy, entryOk, readBulkRequest, SES_BULK_ENDPOINT } from "./support/ses";
import { base64Bytes, makeSigner, type Signer, signEnvelope } from "./support/sns";

// --- fixtures ---------------------------------------------------------------

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

function webhookRequest(envelope: SnsEnvelope): Request {
  return new Request(`${base}/webhooks/ses`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: JSON.stringify(envelope),
  });
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
describe("SesProvider.sendBatch", () => {
  it("batches a second of the account's send rate, up to 50, one request a second, with no idempotency", () => {
    const at = (rate: number) =>
      new SesProvider({ ...getConfig(env), sesMaxSendRate: rate }, sesEnv);
    expect(newProvider().name).toBe("ses");
    expect([1, 14, 50, 200].map((rate) => at(rate).maxBatch)).toEqual([1, 14, 50, 50]);
    expect(at(14).maxRequestRate).toBe(1);
  });

  it("POSTs one SigV4-signed SendBulkEmail with an entry per recipient and its one-click headers (SPEC §10)", async () => {
    let captured: Request | undefined;
    const { requests } = answerSes();
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (input) => {
      captured = (input as Request).clone();
      return new Response(
        JSON.stringify({
          BulkEmailEntryResults: [
            { Status: "SUCCESS", MessageId: "0100-msgid-a" },
            { Status: "SUCCESS", MessageId: "0100-msgid-b" },
          ],
        }),
        { status: 200 },
      );
    });
    const other = "https://app.example.com/unsubscribe?token=cafe";

    const results = await newProvider().sendBatch(
      renderedFixture(),
      [
        { email: "a@example.com", unsubscribeUrl: UNSUB },
        { email: "b@example.com", unsubscribeUrl: other },
      ],
      { purpose: "list", tag: "send-1" },
    );

    // Each entry's result, by position, with SES's MessageId as the providerId.
    expect(results).toEqual({
      kind: "answered",
      results: [
        { email: "a@example.com", accepted: true, providerId: "0100-msgid-a" },
        { email: "b@example.com", accepted: true, providerId: "0100-msgid-b" },
      ],
    });
    expect(requests).toEqual([]); // the one request was answered above
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toBe(SES_BULK_ENDPOINT);
    expect(captured!.headers.get("authorization") ?? "").toMatch(/^AWS4-HMAC-SHA256 /);

    const req = await readBulkRequest(captured);
    expect(req.ConfigurationSetName).toBe("kestrel-events"); // events flow to SNS
    expect(req.FromEmailAddress).toContain("newsletter@send.example.com");
    expect(req.BulkEmailEntries.map((e) => e.Destination.ToAddresses)).toEqual([
      ["a@example.com"],
      ["b@example.com"],
    ]);
    // Each reader gets their own unsubscribe link, in both parts and in the headers.
    const a = deliveredBy(req, 0);
    const b = deliveredBy(req, 1);
    expect(a.headers).toEqual({
      "List-Unsubscribe": `<${UNSUB}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(b.headers["List-Unsubscribe"]).toBe(`<${other}>`);
    expect(a.html).toContain(`href="${UNSUB}"`);
    expect(a.text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(b.html).toContain(`href="${other}"`);
    expect(a.subject).toBe("Weekly Update");
  });

  // I5: the email SES builds from the template is the one the fake sends, so a
  // test through any of them is the send. Built from a real frozen render, with what an
  // author can put in a post that a template engine might read: a `{{`, a token typed as
  // text, a backslash before one, a stray `}}`, and a brace beside a delivery placeholder.
  it("delivers byte for byte what substituteRecipient makes, whatever braces and backslashes the post carries (I5)", async () => {
    const send = await dueSend({
      subject: "Braces {{ .Post.Subject }} and \\{{x}} in a subject",
      markdown: [
        "Literal {{ .Email.UnsubscribeURL }} and {{{triple}}} and \\{{escaped}} and }} here.",
        "",
        "```",
        'if (a) { b("\\n"); } // {{#each}}',
        "```",
        "",
        "A path C:\\Users\\ and a trailing backslash \\",
      ].join("\n"),
    });
    const frozen = { subject: send.subject, html: send.rendered_html, text: send.rendered_text };
    // A brace hard against each delivery placeholder, as a hand-made template could put it.
    frozen.html += `{${UNSUB_SENTINEL}}\\${SENTTO_SENTINEL}{`;
    frozen.text += `\\${UNSUB_SENTINEL}}`;
    const reader = { email: "o'reilly&co@example.com", unsubscribeUrl: `${UNSUB}&x=1` };
    const { requests } = answerSes();

    await newProvider().sendBatch(frozen, [reader], { purpose: "test", tag: "t" });

    const expected = substituteRecipient(frozen, {
      ".Email.UnsubscribeURL": reader.unsubscribeUrl,
      ".Email.SentTo": reader.email,
    });
    const got = deliveredBy(requests[0]!, 0);
    expect({ subject: got.subject, html: got.html, text: got.text }).toEqual(expected);
    // The template SES reads holds no brace or backslash but its own tags.
    for (const part of Object.values(requests[0]!.DefaultContent.Template.TemplateContent)) {
      expect(part.replace(/\{\{\w+\}\}/g, "")).not.toMatch(/[{}\\]/);
    }
  });

  it("sends a test with the same template, data, and headers as the list send, through SendEmail (I5)", async () => {
    const { requests } = answerSes();
    const one = [{ email: "reader@example.com", unsubscribeUrl: UNSUB }];
    for (const purpose of ["test", "list"] as const) {
      await newProvider().sendBatch(renderedFixture(), one, { purpose, tag: "x" });
    }
    // The test stays off SendBulkEmail's one-request-a-second throttle, which the list uses.
    expect(requests.map((r) => r.endpoint)).toEqual(["single", "bulk"]);
    const [test, list] = requests.map((r) => deliveredBy(r, 0));
    expect(test).toEqual(list);
    expect(requests[0]!.DefaultContent.Template.TemplateContent).toEqual(
      requests[1]!.DefaultContent.Template.TemplateContent,
    );
  });

  it("puts no unsubscribe headers on a message with no unsubscribe link (a confirmation)", async () => {
    const { requests } = answerSes();
    await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "new@example.com", unsubscribeUrl: "" }],
      {
        purpose: "confirmation",
        tag: "c",
      },
    );
    expect(deliveredBy(requests[0]!, 0).headers).toEqual({});
  });

  it("encodes a display name with non-ASCII in it, as SES requires of FromEmailAddress", async () => {
    const config = { ...getConfig(env), fromAddress: "Café Notes <news@send.example.com>" };
    const { requests } = answerSes();
    await new SesProvider(config, sesEnv).sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      { purpose: "list", tag: "send-1" },
    );
    const from = requests[0]!.FromEmailAddress;
    expect(from).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <news@send\.example\.com>$/);
    const b64 = from.slice("=?utf-8?B?".length, from.indexOf("?= "));
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe(
      "Café Notes",
    );
  });

  it("keeps an address SES can't take out of the request, failing it alone", async () => {
    const { requests } = answerSes();
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [
        { email: "zoë@example.com", unsubscribeUrl: UNSUB },
        { email: "reader@example.com", unsubscribeUrl: UNSUB },
      ],
      { purpose: "list", tag: "send-1" },
    );
    expect(
      requests.map((q) => q.BulkEmailEntries.map((e) => e.Destination.ToAddresses[0])),
    ).toEqual([["reader@example.com"]]);
    expect(r).toMatchObject({
      kind: "answered",
      results: [
        { email: "zoë@example.com", accepted: false, retryable: false },
        { email: "reader@example.com", accepted: true },
      ],
    });
  });

  it("sends a one-off message to several addresses as one SendEmail each", async () => {
    const { requests } = answerSes();
    const five = ["a", "b", "c", "d", "e"].map((n) => ({
      email: `${n}@example.com`,
      unsubscribeUrl: UNSUB,
    }));
    const r = await newProvider().sendBatch(renderedFixture(), five, {
      purpose: "test",
      tag: "t",
    });
    expect(requests.map((q) => q.endpoint)).toEqual(Array(5).fill("single"));
    expect(r.kind === "answered" && r.results.every((x) => x.accepted)).toBe(true);
  });

  it("halts a one-off message SES refuses for the account, through SendEmail too", async () => {
    answerSes(
      undefined,
      () =>
        new Response(JSON.stringify({ __type: "SendingPausedException", message: "paused" }), {
          status: 400,
        }),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "me@example.com", unsubscribeUrl: UNSUB }],
      { purpose: "test", tag: "t" },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { reason: "account", cause: "suspended" } });
  });

  it("answers a test to several addresses when a later request gets no answer, naming who got what", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n += 1;
      if (n === 2) {
        throw new Error("connection reset");
      }
      return new Response(JSON.stringify({ MessageId: `m${n}` }), { status: 200 });
    });
    const r = await newProvider().sendBatch(
      renderedFixture(),
      ["a@example.com", "b@example.com", "c@example.com"].map((email) => ({
        email,
        unsubscribeUrl: UNSUB,
      })),
      { purpose: "test", tag: "t" },
    );
    expect(n).toBe(2);
    expect(r).toMatchObject({
      kind: "answered",
      results: [
        { email: "a@example.com", accepted: true, providerId: "m1" },
        { email: "b@example.com", accepted: false, retryable: false },
        { email: "c@example.com", accepted: false, retryable: true },
      ],
    });
  });

  it("never halts a batch SES answered short, so a recipient it may have mailed stays in flight (I4)", async () => {
    // SES answered one entry of three, and that one is a throttle: the two it left out may
    // have been mailed, so the batch can't go back to the queue as a whole.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ BulkEmailEntryResults: [{ Status: "ACCOUNT_THROTTLED", Error: "slow" }] }),
        { status: 200 },
      ),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      ["a@example.com", "b@example.com", "c@example.com"].map((email) => ({
        email,
        unsubscribeUrl: UNSUB,
      })),
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toEqual({
      kind: "answered",
      results: [
        {
          email: "a@example.com",
          accepted: false,
          retryable: true,
          error: "ses ACCOUNT_THROTTLED: slow",
          held: true,
        },
      ],
      halt: {
        reason: "unavailable",
        cause: "rate_limit",
        error: "ses ACCOUNT_THROTTLED: slow",
      },
    });
  });

  it("fails a recipient-level entry alone and holds back an entry SES throttled, when others were accepted", async () => {
    answerSes((to) =>
      to === "rejected@example.com"
        ? { Status: "MESSAGE_REJECTED", Error: "Email address is on the suppression list." }
        : to === "throttled@example.com"
          ? { Status: "ACCOUNT_THROTTLED", Error: "Maximum sending rate exceeded." }
          : entryOk(),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      ["ok@example.com", "rejected@example.com", "throttled@example.com"].map((email) => ({
        email,
        unsubscribeUrl: UNSUB,
      })),
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toMatchObject({
      kind: "answered",
      results: [
        { email: "ok@example.com", accepted: true },
        {
          email: "rejected@example.com",
          accepted: false,
          retryable: false,
          error: "ses MESSAGE_REJECTED: Email address is on the suppression list.",
        },
        {
          email: "throttled@example.com",
          accepted: false,
          retryable: true,
          error: "ses ACCOUNT_THROTTLED: Maximum sending rate exceeded.",
          held: true,
        },
      ],
      halt: { reason: "unavailable", cause: "rate_limit" },
    });
  });

  it.each([
    ["ACCOUNT_DAILY_QUOTA_EXCEEDED", "account", "quota"],
    ["ACCOUNT_SENDING_PAUSED", "account", "suspended"],
    ["ACCOUNT_SUSPENDED", "account", "suspended"],
    ["MAIL_FROM_DOMAIN_NOT_VERIFIED", "account", "sender"],
    ["CONFIGURATION_SET_DOES_NOT_EXIST", "account", "configuration"],
    ["CONFIGURATION_SET_NOT_FOUND", "account", "configuration"],
    ["ACCOUNT_THROTTLED", "unavailable", "rate_limit"],
    ["TRANSIENT_FAILURE", "unavailable", "outage"],
  ])("halts a batch whose entries all came back %s (SPEC §12)", async (status, reason, cause) => {
    answerSes(() => ({ Status: status, Error: "SES's words" }));
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [
        { email: "a@example.com", unsubscribeUrl: UNSUB },
        { email: "b@example.com", unsubscribeUrl: UNSUB },
      ],
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toEqual({
      kind: "halted",
      halt: { reason, cause, error: `ses ${status}: SES's words` },
    });
  });

  it("an account refusal outranks a throttle among a batch's entries", async () => {
    answerSes((to) =>
      to === "a@example.com"
        ? { Status: "ACCOUNT_THROTTLED" }
        : { Status: "ACCOUNT_SENDING_PAUSED", Error: "paused" },
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      ["a@example.com", "b@example.com"].map((email) => ({ email, unsubscribeUrl: UNSUB })),
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { reason: "account", cause: "suspended" } });
  });

  it("halts an entry rejected for the sender's own identity, but fails one naming only the recipient", async () => {
    const notVerified = (who: string) => ({
      Status: "MESSAGE_REJECTED",
      Error: `Email address is not verified. The following identities failed the check in region US-EAST-1: ${who}`,
    });
    const one = [{ email: "reader@example.com", unsubscribeUrl: UNSUB }];
    answerSes(() => notVerified("newsletter@send.example.com"));
    expect(
      await newProvider().sendBatch(renderedFixture(), one, {
        purpose: "list",
        tag: "s",
      }),
    ).toMatchObject({ kind: "halted", halt: { reason: "account", cause: "sender" } });
    answerSes(() => notVerified("reader@example.com"));
    expect(
      await newProvider().sendBatch(renderedFixture(), one, {
        purpose: "list",
        tag: "s",
      }),
    ).toMatchObject({ kind: "answered", results: [{ accepted: false, retryable: false }] });
  });

  it("leaves out a recipient SES's answer has no result for, so its fate stays unknown (SPEC §12)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ BulkEmailEntryResults: [entryOk()] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const two = ["a@example.com", "b@example.com"].map((email) => ({
      email,
      unsubscribeUrl: UNSUB,
    }));
    const short = await newProvider().sendBatch(renderedFixture(), two, {
      purpose: "list",
      tag: "s",
    });
    expect(short).toMatchObject({
      kind: "answered",
      results: [{ email: "a@example.com", accepted: true }],
    });
    expect(short.kind === "answered" && short.results.length).toBe(1);
    expect(
      await newProvider().sendBatch(renderedFixture(), two, {
        purpose: "list",
        tag: "s",
      }),
    ).toEqual({ kind: "answered", results: [] });
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
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { ...halt } });
  });

  it("reads the quota wording only on a throttle, not on a rejected message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ __type: "MessageRejected", message: "Daily message quota exceeded." }),
        { status: 400 },
      ),
    );
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toMatchObject({ kind: "answered", results: [{ accepted: false, retryable: false }] });
  });

  it("fails every recipient of a request SES refuses with a 400 for good", async () => {
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
        purpose: "list",
        tag: "send-1",
      },
    );
    expect(r).toMatchObject({
      kind: "answered",
      results: [{ accepted: false, retryable: false }],
    });
  });

  it("holds a 404 that carries no error type as a configuration refusal, rather than failing the batch (SPEC §12)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [
        { email: "a@example.com", unsubscribeUrl: UNSUB },
        { email: "b@example.com", unsubscribeUrl: UNSUB },
      ],
      { purpose: "list", tag: "send-1" },
    );
    expect(r).toEqual({
      kind: "halted",
      halt: { reason: "account", cause: "configuration", error: "ses 404" },
    });
  });

  it("halts a 5xx as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<internal>", { status: 500 }));
    const r = await newProvider().sendBatch(
      renderedFixture(),
      [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
      {
        purpose: "list",
        tag: "send-1",
      },
    );
    expect(r).toMatchObject({ kind: "halted", halt: { reason: "unavailable" } });
  });

  it.each([
    [400, "SendingPausedException", "Account is paused", "suspended"],
    [400, "AccountSuspendedException", "Account is suspended", "suspended"],
    [400, "MailFromDomainNotVerifiedException", "MAIL FROM domain is not verified", "sender"],
    [403, "UnrecognizedClientException", "The token included is invalid", "credentials"],
    [
      404,
      "NotFoundException",
      "Configuration set <kestrel-events> does not exist.",
      "configuration",
    ],
  ])(
    "halts a %i %s as an account refusal, carrying SES's words",
    async (status, type, message, cause) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ __type: type, message }), { status }),
      );
      const r = await newProvider().sendBatch(
        renderedFixture(),
        [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
        { purpose: "list", tag: "send-1" },
      );
      expect(r).toEqual({
        kind: "halted",
        halt: {
          reason: "account",
          cause,
          error: `ses ${status} ${type}: ${message}`,
        },
      });
    },
  );

  it.each(["test", "confirmation"] as const)(
    "holds a %s SES answers with a configuration set it can't find, rather than failing the address (SPEC §12)",
    async (purpose) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            __type: "NotFoundException",
            message: "Configuration set <kestrel-events> does not exist.",
          }),
          { status: 404 },
        ),
      );
      const r = await newProvider().sendBatch(
        renderedFixture(),
        [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
        { purpose, tag: "t" },
      );
      expect(r).toEqual({
        kind: "halted",
        halt: {
          reason: "account",
          cause: "configuration",
          error: "ses 404 NotFoundException: Configuration set <kestrel-events> does not exist.",
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
      { purpose: "list", tag: "send-1" },
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
      await newProvider().sendBatch(renderedFixture(), one, {
        purpose: "list",
        tag: "s",
      }),
    ).toMatchObject({
      kind: "halted",
      halt: { reason: "account", cause: "sender" },
    });
    expect(
      await newProvider().sendBatch(renderedFixture(), one, {
        purpose: "list",
        tag: "s",
      }),
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
          purpose: "list",
          tag: "send-1",
        },
      ),
    ).rejects.toThrow(/connection reset/);
  });

  it("ends a request SES never answers, and throws it as the same ambiguous no-answer", async () => {
    // The timeout carries its signal through aws4fetch's signed Request, and the abort
    // takes the transport error's path above: thrown, so the row stays in flight for Resolve.
    const { timeout, reason } = neverAnswers();
    await expect(
      newProvider().sendBatch(
        renderedFixture(),
        [{ email: "reader@example.com", unsubscribeUrl: UNSUB }],
        { purpose: "list", tag: "send-1" },
      ),
    ).rejects.toBe(reason);
    expect(timeout).toHaveBeenCalledWith(PROVIDER_REQUEST_TIMEOUT_MS);
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

    expect(await deliveryEvent("msg-hard-1")).toBe("bounced");
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

  it("records a delivery notification without suppressing", async () => {
    const signer = await makeSigner();
    mockCert(signer);
    await seedDelivery("arrived@example.com", "msg-dlv-1");

    const message = JSON.stringify({
      notificationType: "Delivery",
      mail: { messageId: "msg-dlv-1", destination: ["arrived@example.com"] },
      delivery: { recipients: ["arrived@example.com"] },
    });
    const envelope = await signEnvelope(notification(signer, message), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([
      { type: "delivered", providerId: "msg-dlv-1", email: "arrived@example.com" },
    ]);
    const applied = await applyDeliveryEvents(env.DB, result.events);
    expect(applied).toEqual({ applied: 1, suppressed: 0 });
    expect(await deliveryEvent("msg-dlv-1")).toBe("delivered");
    expect(await subscribers.isSuppressed(env.DB, "arrived@example.com")).toBe(false);
  });

  it("logs a rendering failure as an error, since SES dropped a message the record shows as accepted (SPEC §12)", async () => {
    allowErrorLogs("webhook.render_failed");
    const signer = await makeSigner();
    mockCert(signer);
    const errors = vi.spyOn(console, "error");
    const message = JSON.stringify({
      eventType: "Rendering Failure",
      mail: { messageId: "msg-rf-1", destination: ["reader@example.com"] },
      failure: {
        errorMessage: "Attribute 'email_sentto_html' is not present in the rendering data.",
      },
    });
    const envelope = await signEnvelope(notification(signer, message), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([]);
    expect(logged(errors).filter((l) => l.event === "webhook.render_failed")).toMatchObject([
      {
        level: "error",
        provider: "ses",
        error: "Attribute 'email_sentto_html' is not present in the rendering data.",
      },
    ]);
  });

  it("verifies a SignatureVersion 1 (SHA-1) message, as SNS still sends by default", async () => {
    const signer = await makeSigner("SHA-1");
    mockCert(signer);

    const envelope = await signEnvelope(
      {
        ...notification(signer, bounceMessage("v1@example.com", "msg-v1", "Permanent")),
        SignatureVersion: "1",
      },
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toMatchObject([{ type: "bounced", email: "v1@example.com", hard: true }]);

    // The version names the hash: the same SHA-1 signature claimed as version 2 fails.
    _clearKeyCache();
    const misnamed = await newProvider().parseWebhook(
      webhookRequest({ ...envelope, SignatureVersion: "2" }),
      sesEnv,
    );
    expect(misnamed.response.status).toBe(403);
    expect(misnamed.events).toEqual([]);
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

  it("answers 502 when the SubscribeURL fetch fails, so SNS retries the handshake", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    let fetched = false;
    mockCert(signer, (url) => {
      if (url === subscribeUrl) {
        fetched = true;
        return new Response("Service Unavailable", { status: 503 });
      }
      return undefined;
    });

    const envelope = await signEnvelope(subscriptionConfirmation(signer, subscribeUrl), signer);
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(fetched).toBe(true);
    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toBe("subscription confirmation failed");
    expect(result.events).toEqual([]);
  });

  it("acknowledges an UnsubscribeConfirmation without fetching anything or applying events", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    const { fetched } = mockSubscribe(signer, subscribeUrl);

    const envelope = await signEnvelope(
      { ...subscriptionConfirmation(signer, subscribeUrl), Type: "UnsubscribeConfirmation" },
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(200);
    expect(result.events).toEqual([]);
    expect(fetched.subscribe).toBe(false);
  });

  it("refuses a correctly signed message of a type it doesn't know with 400", async () => {
    const signer = await makeSigner();
    const subscribeUrl = newSubscribeUrl();
    const { fetched } = mockSubscribe(signer, subscribeUrl);

    const envelope = await signEnvelope(
      { ...subscriptionConfirmation(signer, subscribeUrl), Type: "SomethingNew" },
      signer,
    );
    const result = await newProvider().parseWebhook(webhookRequest(envelope), sesEnv);

    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe("unsupported message type");
    expect(result.events).toEqual([]);
    expect(fetched.subscribe).toBe(false);
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
    // Applied as the route applies them: had the bounce slipped through, this suppresses.
    await applyDeliveryEvents(env.DB, result.events);
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
    // Applied as the route applies them: had the bounce slipped through, this suppresses.
    await applyDeliveryEvents(env.DB, result.events);
    expect(await subscribers.isSuppressed(env.DB, "victim@example.com")).toBe(false);
    expect(await deliveryEvent("msg-forged-1")).toBeNull();
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
      new Request(`${base}/webhooks/ses`, { method: "POST", body: "not json" }),
      sesEnv,
    );
    expect(result.response.status).toBe(400);
    expect(result.events).toHaveLength(0);
  });
});
