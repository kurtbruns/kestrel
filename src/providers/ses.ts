/**
 * Amazon SES adapter (SESv2 SendEmail over HTTPS, SigV4-signed with aws4fetch).
 *
 * Sending: one Raw MIME message per recipient (see ses_mime.ts) so each carries
 * its own unsubscribe URL and RFC 8058 one-click headers, POSTed to the SESv2
 * `outbound-emails` endpoint. Hence `maxBatch = 1`.
 *
 * Idempotency: SESv2 SendEmail has NO idempotency key, so `idempotentRetry` is
 * false — a stuck `dispatched` row must never be blindly re-sent (the send loop
 * honors this flag and leaves such rows for a human). At-most-once (I4) is
 * upheld by never re-dispatching, not by dedupe.
 *
 * Failures: SES answers each recipient's request on its own, so an error that is about
 * SES or the account rather than the recipient (`classifySesError`) halts the batch at
 * that request instead of being repeated, identically, for everyone after it.
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
import { substituteRecipient } from "../render/render";
import { base64Utf8, buildRawMessage } from "./ses_mime";
import { isSnsHost, mapSesNotification, type SnsEnvelope, verifySnsSignature } from "./sns";
import type {
  BatchHalt,
  EmailProvider,
  HaltCause,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "./types";

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
  // The credentials themselves: unknown, wrongly signed, expired, or not permitted.
  ["UnrecognizedClientException", "credentials"],
  ["InvalidClientTokenId", "credentials"],
  ["SignatureDoesNotMatch", "credentials"],
  ["ExpiredTokenException", "credentials"],
  ["AccessDeniedException", "credentials"],
]);

/**
 * Whether an SES error response halts the batch, and why; null when it is about this
 * recipient's message (a bad address, a rejected message), which is permanent for it
 * alone. The account-level types, any 401 or 403, and a rejection because the sender's
 * own identity is not verified (`senderUnverified`, which the caller works out from the
 * message) need the operator, as does a spent daily quota, which SES reports as the same
 * throttle as its per-second rate and tells apart only by the message: it won't lift for
 * up to a day, so the operator hears "quota", as Resend's does. Any other throttling (a
 * 429, or a throttling type on a 400) and a 5xx are SES being unavailable: the next
 * recipient would get the same answer, so the batch waits for the next tick instead. An
 * SES error response always means SES did not accept the message, so none of these
 * leaves the fate unknown.
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

export class SesProvider implements EmailProvider {
  readonly name = "ses" as const;
  readonly maxBatch = 1;
  readonly idempotentRetry = false;

  private readonly client: AwsClient;
  private readonly region: string;
  private readonly from: string;
  private readonly configurationSet: string | undefined;

  constructor(config: Config, env: AppEnv) {
    this.region = config.awsRegion;
    this.from = config.fromAddress;
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
    return `https://email.${this.region}.amazonaws.com/v2/email/outbound-emails`;
  }

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    _opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const out: PerRecipientResult[] = [];
    // maxBatch is 1, so the send loop passes one recipient; only a one-off caller (a
    // template test to several addresses) passes more.
    for (const [i, r] of recipients.entries()) {
      const result = await this.sendOne(rendered, r);
      if ("reason" in result) {
        if (out.length === 0) {
          return { kind: "halted", halt: result };
        }
        // Some were already accepted, so the batch can't be refused as a whole: the rest
        // are simply not sent this time, and wait for the next tick.
        for (const rest of recipients.slice(i)) {
          out.push({ email: rest.email, accepted: false, retryable: true, error: result.error });
        }
        break;
      }
      out.push(result);
    }
    return { kind: "answered", results: out };
  }

  private async sendOne(
    rendered: RenderedEmail,
    r: Recipient,
  ): Promise<PerRecipientResult | BatchHalt> {
    const final = substituteRecipient(rendered, {
      "email.unsubscribeUrl": r.unsubscribeUrl,
      "email.sentTo": r.email,
    });
    const raw = buildRawMessage({
      from: this.from,
      to: r.email,
      subject: final.subject,
      html: final.html,
      text: final.text,
      unsubscribeUrl: r.unsubscribeUrl,
    });

    const payload: Record<string, unknown> = {
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [r.email] },
      Content: { Raw: { Data: base64Utf8(raw) } },
    };
    if (this.configurationSet) {
      payload.ConfigurationSetName = this.configurationSet;
    }

    // A transport error (no HTTP response) is AMBIGUOUS: SES may or may not have
    // accepted the message. Because this provider is not idempotent, we must not
    // auto-retry it (that risks a duplicate, violating I4). We let it throw so
    // the send loop leaves the row `dispatched` for a human — its designed
    // at-most-once handling for non-idempotent providers. A real HTTP error
    // response below is unambiguous (SES did NOT accept) and is safely retryable.
    const res = await this.client.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      let providerId = "";
      try {
        const body = (await res.json()) as { MessageId?: string };
        providerId = body.MessageId ?? "";
      } catch {
        /* a 200 with an unreadable body still means accepted */
      }
      return { email: r.email, accepted: true, providerId };
    }

    const bodyText = await res.text().catch(() => "");
    const { type, message } = parseSesError(bodyText, res.headers.get("x-amzn-ErrorType"));
    const detail = [type, message].filter(Boolean).join(": ");
    const error = `ses ${res.status}${detail ? ` ${detail}` : ""}`;
    // A sandbox account, or a sending identity that lapsed, is rejected as MessageRejected
    // naming the identities that failed; it is the operator's only when the sender is one.
    const senderUnverified =
      type === "MessageRejected" &&
      /not verified/i.test(message) &&
      message.toLowerCase().includes(bareAddress(this.from));
    const halt = classifySesError(res.status, type, message, senderUnverified);
    if (halt) {
      return { ...halt, error };
    }
    // Every other 4xx (a bad address, a rejected message, ...) is this recipient's alone.
    return { email: r.email, accepted: false, retryable: false, error };
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
