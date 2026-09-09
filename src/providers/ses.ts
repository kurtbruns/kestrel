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
 * Webhook: `parseWebhook` verifies the SNS signature, then confirms a
 * subscription or normalizes an SES bounce/complaint/delivery into events. It
 * has no idea about the database — the route applies the returned events.
 *
 * SigV4 note: SESv2 signs under the service name `ses` (not `sesv2`), and the
 * endpoint host `email.{region}.amazonaws.com` would otherwise be misread as the
 * `email` service, so we set `service: "ses"` explicitly.
 */
import { AwsClient } from "aws4fetch";
import type { AppEnv, Config } from "../env";
import { substituteUnsubscribe } from "../render/render";
import { base64Utf8, buildRawMessage } from "./ses_mime";
import { isSnsHost, mapSesNotification, type SnsEnvelope, verifySnsSignature } from "./sns";
import type {
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  WebhookResult,
} from "./types";

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
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
  ): Promise<PerRecipientResult[]> {
    const out: PerRecipientResult[] = [];
    // maxBatch is 1, but stay correct if the loop ever passes more.
    for (const r of recipients) {
      out.push(await this.sendOne(rendered, r));
    }
    return out;
  }

  private async sendOne(rendered: RenderedEmail, r: Recipient): Promise<PerRecipientResult> {
    const final = substituteUnsubscribe(rendered, r.unsubscribeUrl);
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
    const { type, message } = parseSesError(bodyText);
    // Throttling (429, or a Throttling/TooManyRequests type on a 400) and 5xx are
    // transient; every other 4xx (bad address, rejected message, ...) is permanent.
    const throttled = res.status === 429 || /throttl|toomany/i.test(type);
    const retryable = throttled || res.status >= 500;
    const detail = [type, message].filter(Boolean).join(": ");
    return {
      email: r.email,
      accepted: false,
      retryable,
      error: `ses ${res.status}${detail ? ` ${detail}` : ""}`,
    };
  }

  async parseWebhook(req: Request, _env: AppEnv): Promise<WebhookResult> {
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

/** Pull a type + message out of an SESv2 JSON error body (best effort). */
function parseSesError(text: string): { type: string; message: string } {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const rawType = String(j.__type ?? j.code ?? j.type ?? "");
    const type = rawType.split("#").pop() ?? rawType;
    const message = String(j.message ?? j.Message ?? "");
    return { type, message };
  } catch {
    return { type: "", message: text.slice(0, 200) };
  }
}
