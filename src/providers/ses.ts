/**
 * Amazon SES adapter (SESv2 SendBulkEmail over HTTPS, SigV4-signed with aws4fetch).
 *
 * Sending: one SendBulkEmail request a batch, to the SESv2 `outbound-bulk-emails` endpoint.
 * The frozen render goes once, as an inline template (ses_template.ts), and each recipient
 * as an entry with its own template data (its unsubscribe URL and address, as the render's
 * delivery pass fills them) and its own RFC 8058 one-click headers. A test, a confirmation,
 * and a notification go the same way with one entry, so a test is the send (I5).
 *
 * Throughput: a request takes up to 50 destinations, but SES throttles every action but its
 * single sends to one request a second, and counts each destination against the account's
 * maximum send rate. So a batch is the send rate's worth of recipients, up to 50, and the
 * send loop starts one request a second (`sesTraits`).
 *
 * Idempotency: SESv2 has NO idempotency key, so `idempotentRetry` is false — a stuck
 * `dispatched` row must never be blindly re-sent (the send loop honors this flag and leaves
 * such rows for a human). At-most-once (I4) is upheld by never re-dispatching, not by
 * dedupe. A request lost in flight leaves its whole batch for Resolve.
 *
 * Failures: SES answers a request either with an error that speaks for all of it, or with
 * one result an entry. An error, or an entry status, that is about SES or the account rather
 * than the recipient (`classifySesError`, `classifySesEntry`) halts the batch when nothing in
 * it was accepted, and otherwise sends those recipients back to wait for the next tick.
 *
 * Webhook: `parseWebhook` verifies the SNS signature and that the message came from
 * this deployment's `SNS_TOPIC_ARN`, then confirms a subscription or normalizes an SES
 * bounce/complaint/delivery into events. It has no idea about the database: the
 * route applies the returned events.
 *
 * SigV4 note: SESv2 signs under the service name `ses` (not `sesv2`), and the
 * endpoint host `email.{region}.amazonaws.com` would otherwise be misread as the
 * `email` service, so we set `service: "ses"` explicitly.
 */
import { AwsClient } from "aws4fetch";
import type { AppEnv, Config } from "../env";
import { log } from "../lib/log";
import {
  type SesTemplateContent,
  sesCanAddress,
  sesFromAddress,
  sesTemplateContent,
  sesTemplateData,
} from "./ses_template";
import {
  isSnsHost,
  mapSesNotification,
  type SnsEnvelope,
  sesRenderingFailure,
  verifySnsSignature,
} from "./sns";
import {
  type BatchHalt,
  type EmailProvider,
  type HaltCause,
  type PerRecipientResult,
  PROVIDER_REQUEST_TIMEOUT_MS,
  type ProviderTraits,
  type Recipient,
  type RenderedEmail,
  type SendBatchOptions,
  type SendBatchResult,
  type WebhookResult,
} from "./types";

/** The most destinations one SendBulkEmail request takes. */
export const SES_BULK_MAX = 50;

/** How many SendBulkEmail requests a second SES takes: it throttles every action but
 *  SendEmail, SendRawEmail, and SendTemplatedEmail to one. */
export const SES_BULK_REQUEST_RATE = 1;

/**
 * How SES behaves under the send loop: a batch is one second of the account's maximum send
 * rate, up to the 50 a request takes, since SES counts every destination of a request
 * against that rate, and one request a second; no idempotency key, so a request that got no
 * answer is never re-sent. The dev simulation's SES profile reads these, so it can't drift.
 */
export function sesTraits(config: Config): ProviderTraits & { maxRequestRate: number } {
  return {
    maxBatch: Math.max(1, Math.min(SES_BULK_MAX, Math.floor(config.sesMaxSendRate))),
    idempotentRetry: false,
    maxRequestRate: SES_BULK_REQUEST_RATE,
  };
}

/** An SES error response as the operator reads it: the status, then SES's type and message. */
export function sesErrorText(status: number, type: string, message: string): string {
  const detail = [type, message].filter(Boolean).join(": ");
  return `ses ${status}${detail ? ` ${detail}` : ""}`;
}

/** One entry's failed result as the operator reads it: SES's status, then its words. */
export function sesEntryErrorText(status: string, error: string): string {
  return `ses ${status}${error ? `: ${error}` : ""}`;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Error types that are about the account or its credentials, never a recipient, by
 *  what the operator has to fix. */
const ACCOUNT_ERROR_TYPES = new Map<string, HaltCause>([
  // AWS paused the account's sending (it does so on bounce or complaint trouble) or
  // restricted it for good; either way, until the operator acts in the SES console.
  ["SendingPausedException", "suspended"],
  ["AccountSuspendedException", "suspended"],
  ["MailFromDomainNotVerifiedException", "sender"],
  // The credentials themselves: unknown, wrongly signed, expired, or not permitted (a key
  // whose policy lacks `ses:SendBulkEmail` among them).
  ["UnrecognizedClientException", "credentials"],
  ["InvalidClientTokenId", "credentials"],
  ["SignatureDoesNotMatch", "credentials"],
  ["ExpiredTokenException", "credentials"],
  ["AccessDeniedException", "credentials"],
]);

/**
 * Whether an SES error response halts the batch, and why; null when it is about the
 * message (a rejected message, an invalid request), which no retry changes. The
 * account-level types, any 401 or 403, and a rejection because the sender's own identity
 * is not verified (`senderUnverified`, which the caller works out from the message) need
 * the operator, as does a spent daily quota, which SES reports as the same throttle as its
 * per-second rate and tells apart only by the message: it won't lift for up to a day, so
 * the operator hears "quota", as Resend's does. Any other throttling (a 429, or a
 * throttling type on a 400) and a 5xx are SES being unavailable: the next request would get
 * the same answer, so the batch waits for the next tick instead. An SES error response
 * always means SES did not accept the request, so none of these leaves the fate unknown.
 */
export function classifySesError(
  status: number,
  type: string,
  message = "",
  senderUnverified = false,
): Omit<BatchHalt, "error"> | null {
  const throttled = status === 429 || /throttl|toomany/i.test(type);
  const cause =
    ACCOUNT_ERROR_TYPES.get(type) ??
    (senderUnverified
      ? "sender"
      : throttled && /daily message quota/i.test(message)
        ? "quota"
        : undefined);
  if (cause || status === 401 || status === 403) {
    return { reason: "account", cause: cause ?? "credentials", mayHaveSent: false };
  }
  if (throttled) {
    return { reason: "unavailable", cause: "rate_limit", mayHaveSent: false };
  }
  if (status >= 500) {
    return { reason: "unavailable", cause: "outage", mayHaveSent: false };
  }
  return null;
}

const account = (cause: HaltCause): Omit<BatchHalt, "error"> => ({
  reason: "account",
  cause,
  mayHaveSent: false,
});
const unavailable = (cause: HaltCause): Omit<BatchHalt, "error"> => ({
  reason: "unavailable",
  cause,
  mayHaveSent: false,
});

/** Entry statuses that are about SES, the account, or the deployment's settings, never the
 *  recipient. A configuration set, sending pool, or template SES can't find is the
 *  deployment's to fix, in its secrets. */
const ENTRY_HALTS = new Map<string, Omit<BatchHalt, "error">>([
  ["ACCOUNT_SUSPENDED", account("suspended")],
  ["ACCOUNT_SENDING_PAUSED", account("suspended")],
  ["CONFIGURATION_SET_SENDING_PAUSED", account("suspended")],
  ["MAIL_FROM_DOMAIN_NOT_VERIFIED", account("sender")],
  ["ACCOUNT_DAILY_QUOTA_EXCEEDED", account("quota")],
  ["CONFIGURATION_SET_DOES_NOT_EXIST", account("credentials")],
  ["CONFIGURATION_SET_NOT_FOUND", account("credentials")],
  ["INVALID_SENDING_POOL_NAME", account("credentials")],
  ["TEMPLATE_DOES_NOT_EXIST", account("credentials")],
  ["TEMPLATE_NOT_FOUND", account("credentials")],
  ["ACCOUNT_THROTTLED", unavailable("rate_limit")],
  ["TRANSIENT_FAILURE", unavailable("outage")],
]);

/**
 * Whether one entry's failed result is about SES or the account rather than its recipient,
 * and why; null when it is the recipient's alone (a rejected message, an invalid parameter,
 * a plain `FAILED`), which is permanent for them. A rejection because the sender's own
 * identity is not verified (`senderUnverified`) is the operator's, as on a whole request.
 */
export function classifySesEntry(
  status: string,
  senderUnverified = false,
): Omit<BatchHalt, "error"> | null {
  return ENTRY_HALTS.get(status) ?? (senderUnverified ? account("sender") : null);
}

interface BulkEntryResult {
  Status?: string;
  MessageId?: string;
  Error?: string;
}

/** A batch's halt, or the halt that outranks it: an account refusal is the one the
 *  publisher has to act on, so it wins over a provider that is only unavailable. */
function worse(a: BatchHalt | null, b: BatchHalt): BatchHalt {
  return !a || (a.reason === "unavailable" && b.reason === "account") ? b : a;
}

export class SesProvider implements EmailProvider {
  readonly name = "ses" as const;
  readonly maxBatch: number;
  readonly idempotentRetry: boolean;
  readonly maxRequestRate: number;

  private readonly client: AwsClient;
  private readonly region: string;
  private readonly from: string;
  private readonly configurationSet: string | undefined;

  constructor(config: Config, env: AppEnv) {
    this.region = config.awsRegion;
    this.from = config.fromAddress;
    const traits = sesTraits(config);
    this.maxBatch = traits.maxBatch;
    this.idempotentRetry = traits.idempotentRetry;
    this.maxRequestRate = traits.maxRequestRate;
    this.configurationSet =
      env.SES_CONFIGURATION_SET && env.SES_CONFIGURATION_SET.length > 0
        ? env.SES_CONFIGURATION_SET
        : undefined;
    this.client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
      service: "ses",
      region: config.awsRegion,
      // The send loop owns retry cadence (per sweep tick); disable aws4fetch's
      // own ret/backoff so one sendBatch attempt makes exactly one HTTP call.
      retries: 0,
    });
  }

  private get endpoint(): string {
    return `https://email.${this.region}.amazonaws.com/v2/email/outbound-bulk-emails`;
  }

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    _opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const out: PerRecipientResult[] = [];
    const sendable: Recipient[] = [];
    for (const r of recipients) {
      if (sesCanAddress(r.email)) {
        sendable.push(r);
      } else {
        // SES refuses such an address for the whole request, so it stays out of it and
        // fails alone, as it did when each recipient had a request of their own.
        out.push({
          email: r.email,
          accepted: false,
          retryable: false,
          error: "ses can't send to an address with characters outside ASCII",
        });
      }
    }
    const content = sesTemplateContent(rendered);
    // The send loop passes at most `maxBatch`; only a one-off caller (a template test to
    // several addresses) passes more, which goes as several requests.
    for (let at = 0; at < sendable.length; at += this.maxBatch) {
      const batch = sendable.slice(at, at + this.maxBatch);
      const answer = await this.sendBulk(content, batch);
      if (answer.kind === "halted") {
        if (!out.some((r) => r.accepted)) {
          return answer;
        }
        // Some were already accepted, so the batch can't be refused as a whole: the rest
        // are simply not sent this time, and wait for the next tick.
        for (const rest of sendable.slice(at)) {
          out.push({
            email: rest.email,
            accepted: false,
            retryable: true,
            error: answer.halt.error,
          });
        }
        break;
      }
      out.push(...answer.results);
    }
    return { kind: "answered", results: out };
  }

  /** One SendBulkEmail request for up to `maxBatch` recipients. */
  private async sendBulk(
    content: SesTemplateContent,
    batch: Recipient[],
  ): Promise<SendBatchResult> {
    const payload: Record<string, unknown> = {
      FromEmailAddress: sesFromAddress(this.from),
      // Every entry carries all of its data, so the default is empty: an entry SES read
      // without its own data would fail to render rather than go out with someone else's.
      DefaultContent: { Template: { TemplateContent: content, TemplateData: "{}" } },
      BulkEmailEntries: batch.map((r) => ({
        Destination: { ToAddresses: [r.email] },
        ReplacementEmailContent: {
          ReplacementTemplate: {
            ReplacementTemplateData: JSON.stringify(
              sesTemplateData({
                ".Email.UnsubscribeURL": r.unsubscribeUrl,
                ".Email.SentTo": r.email,
              }),
            ),
          },
        },
        ReplacementHeaders: [
          { Name: "List-Unsubscribe", Value: `<${r.unsubscribeUrl}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ],
      })),
    };
    if (this.configurationSet) {
      payload.ConfigurationSetName = this.configurationSet;
    }

    // A transport error (no HTTP response) is AMBIGUOUS: SES may or may not have
    // accepted the batch. Because this provider is not idempotent, we must not
    // auto-retry it (that risks a duplicate, violating I4). We let it throw so
    // the send loop leaves the batch `dispatched` for a human — its designed
    // at-most-once handling for non-idempotent providers. A real HTTP error
    // response below is unambiguous (SES did NOT accept) and is safely retryable.
    // A request SES never answers is ended the same way: the timeout rejects the fetch,
    // so it throws down that same path. aws4fetch carries `signal` onto the signed Request.
    const res = await this.client.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const { type, message } = parseSesError(bodyText, res.headers.get("x-amzn-ErrorType"));
      const error = sesErrorText(res.status, type, message);
      const halt = classifySesError(
        res.status,
        type,
        message,
        type === "MessageRejected" && this.namesSender(message),
      );
      if (halt) {
        return { kind: "halted", halt: { ...halt, error } };
      }
      // Any other 4xx refuses the request's content (too large for a template, say),
      // which is the same for every recipient in it, so it is permanent for each.
      return {
        kind: "answered",
        results: batch.map((r) => ({ email: r.email, accepted: false, retryable: false, error })),
      };
    }

    // SES took the request. Results come one an entry, in the entries' order; a recipient
    // with no result (an unreadable answer, or a short one) is left out, so its fate stays
    // unknown and it waits for Resolve rather than being guessed at.
    let entries: BulkEntryResult[] = [];
    try {
      const body = (await res.json()) as { BulkEmailEntryResults?: BulkEntryResult[] };
      entries = Array.isArray(body.BulkEmailEntryResults) ? body.BulkEmailEntryResults : [];
    } catch {
      entries = [];
    }
    const results: PerRecipientResult[] = [];
    const heldBack: { email: string; error: string }[] = [];
    let halt: BatchHalt | null = null;
    for (const [i, r] of batch.entries()) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }
      const status = entry.Status ?? "";
      if (status === "SUCCESS") {
        results.push({ email: r.email, accepted: true, providerId: entry.MessageId ?? "" });
        continue;
      }
      const words = entry.Error ?? "";
      const error = sesEntryErrorText(status || "FAILED", words);
      const entryHalt = classifySesEntry(
        status,
        status === "MESSAGE_REJECTED" && this.namesSender(words),
      );
      if (entryHalt) {
        halt = worse(halt, { ...entryHalt, error });
        heldBack.push({ email: r.email, error });
      } else {
        results.push({ email: r.email, accepted: false, retryable: false, error });
      }
    }
    if (halt && !results.some((r) => r.accepted)) {
      return { kind: "halted", halt };
    }
    // Some were accepted, so the request can't be refused as a whole: the recipients SES
    // held back for its own reasons wait for the next tick.
    for (const h of heldBack) {
      results.push({ email: h.email, accepted: false, retryable: true, error: h.error });
    }
    return { kind: "answered", results };
  }

  /** Whether SES's "not verified" words name this deployment's own sender, which makes a
   *  rejection the operator's (a sandbox account, or a sending identity that lapsed)
   *  rather than the recipient's. */
  private namesSender(message: string): boolean {
    return /not verified/i.test(message) && message.toLowerCase().includes(bareAddress(this.from));
  }

  async parseWebhook(req: Request, env: AppEnv): Promise<WebhookResult> {
    // Fail closed: without the expected topic, no message can be told apart from one a
    // stranger's topic sent, so nothing is accepted (getConfig also refuses to run so).
    const expectedTopic = env.SNS_TOPIC_ARN?.trim();
    if (!expectedTopic) {
      return { events: [], response: textResponse("webhook topic not configured", 403) };
    }

    let msg: SnsEnvelope;
    try {
      msg = JSON.parse(await req.text()) as SnsEnvelope;
    } catch {
      return { events: [], response: textResponse("invalid json", 400) };
    }

    // Signature first: the route is public, so nothing acts on an unverified msg.
    if (!(await verifySnsSignature(msg))) {
      return { events: [], response: textResponse("invalid signature", 403) };
    }
    // SNS signs for every topic in every account, so a valid signature proves only that
    // SNS sent it. The topic proves it is ours, and is checked before any handling, a
    // subscription confirmation included, so a foreign topic can neither subscribe this
    // endpoint nor suppress the list with forged bounces (I1).
    if (msg.TopicArn !== expectedTopic) {
      return { events: [], response: textResponse("unexpected topic", 403) };
    }

    switch (msg.Type) {
      case "SubscriptionConfirmation": {
        const ok = await confirmSubscription(msg.SubscribeURL);
        return {
          events: [],
          response: ok
            ? textResponse("subscription confirmed", 200)
            : textResponse("subscription confirmation failed", 502),
        };
      }
      case "Notification": {
        // A message SES took but could not fill from its data is never sent, and nothing
        // in the record shows it: say so loudly, since it would mean every entry built
        // the same way failed too (ses_template.ts).
        const failure = sesRenderingFailure(msg.Message ?? "");
        if (failure !== null) {
          log.error("webhook.render_failed", { provider: "ses", error: failure });
        }
        const events = mapSesNotification(msg.Message ?? "");
        return { events, response: textResponse("ok", 200) };
      }
      case "UnsubscribeConfirmation":
        // Acknowledge so SNS stops retrying; nothing to apply.
        return { events: [], response: textResponse("ok", 200) };
      default:
        return { events: [], response: textResponse("unsupported message type", 400) };
    }
  }
}

/** GET the SubscribeURL to complete the SNS handshake (host pinned first). */
async function confirmSubscription(subscribeUrl: string | undefined): Promise<boolean> {
  if (!subscribeUrl) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(subscribeUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !isSnsHost(u.hostname)) {
    return false;
  }
  try {
    const res = await fetch(subscribeUrl);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pull a type + message out of an SESv2 error (best effort). The REST API names the type
 * in the `x-amzn-ErrorType` header (`Type:namespace-url`), and the body may carry only
 * the message, so the header is the fallback when the body names no type.
 */
function parseSesError(
  text: string,
  headerType: string | null = null,
): { type: string; message: string } {
  const fromHeader = (headerType ?? "").split(":")[0]?.trim() ?? "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const rawType = String(j.__type ?? j.code ?? j.type ?? "");
    const type = (rawType.split("#").pop() ?? rawType) || fromHeader;
    const message = String(j.message ?? j.Message ?? "");
    return { type, message };
  } catch {
    return { type: fromHeader, message: text.slice(0, 200) };
  }
}

/** The bare address of a `Name <addr>` from-line, lowercased. */
function bareAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from);
  return (angle?.[1] ?? from).trim().toLowerCase();
}
