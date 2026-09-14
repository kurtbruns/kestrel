/**
 * Resend transport adapter. Mirrors FakeProvider's structure; talks to the REST
 * API with `fetch` (no SDK). Two responsibilities behind the seam:
 *
 *   sendBatch    — POST /emails/batch, one object per recipient with the
 *                  unsubscribe sentinel substituted and RFC 8058 one-click
 *                  List-Unsubscribe headers. An Idempotency-Key derived from the
 *                  send id + the chunk's recipients lets a re-sent stuck chunk be
 *                  deduped by Resend instead of double-mailing (idempotentRetry).
 *   parseWebhook — verify the Svix signature over the raw body, then normalize
 *                  Resend events (delivered / bounced / complained) into the
 *                  provider-agnostic DeliveryEvent[] the record applies.
 *
 * Nothing here is domain-specific: the from-address comes from config, the key
 * and webhook secret from env. Dev never selects this adapter (PROVIDER=fake).
 */
import type { AppEnv, Config } from "../env";
import { timingSafeEqual } from "../lib/constant_time";
import { substituteRecipient } from "../render/render";
import type {
  DeliveryEvent,
  EmailProvider,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  WebhookResult,
} from "./types";

const BATCH_URL = "https://api.resend.com/emails/batch";
/** Resend caps a batch send at 100 messages. */
const MAX_BATCH = 100;
/** Reject a webhook whose Svix timestamp is more than this far from now. */
const WEBHOOK_TOLERANCE_S = 5 * 60;

interface ResendBatchElement {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend" as const;
  readonly maxBatch = MAX_BATCH;
  readonly idempotentRetry = true;

  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly from: string;

  constructor(config: Config, env: AppEnv) {
    this.apiKey = env.RESEND_API_KEY ?? "";
    this.webhookSecret = env.RESEND_WEBHOOK_SECRET ?? "";
    this.from = config.fromAddress;
  }

  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<PerRecipientResult[]> {
    const elements: ResendBatchElement[] = recipients.map((r) => {
      const final = substituteRecipient(rendered, {
        "email.unsubscribeUrl": r.unsubscribeUrl,
        "email.sentTo": r.email,
      });
      return {
        from: this.from,
        to: [r.email],
        subject: final.subject,
        html: final.html,
        text: final.text,
        headers: {
          "List-Unsubscribe": `<${r.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

    const res = await fetch(BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // Stable across retries of the same chunk, distinct across chunks, so a
        // replayed stuck chunk is deduped while a genuinely new chunk is not.
        "Idempotency-Key": await chunkIdempotencyKey(opts.idempotencyKeyPrefix, recipients),
      },
      // The batch endpoint takes the JSON array of email objects as the body.
      body: JSON.stringify(elements),
    });

    if (!res.ok) {
      // 429 / 5xx are transient (retry next tick); other 4xx are permanent.
      const retryable = res.status === 429 || res.status >= 500;
      const error = `resend batch ${res.status}: ${await safeText(res)}`;
      return recipients.map((r) => ({
        email: r.email,
        accepted: false as const,
        retryable,
        error,
      }));
    }

    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    const data = Array.isArray(body.data) ? body.data : [];
    return recipients.map((r, i) => {
      const id = data[i]?.id;
      if (id) {
        return { email: r.email, accepted: true as const, providerId: id };
      }
      // A 2xx without a matching id is ambiguous — let the next tick retry.
      return {
        email: r.email,
        accepted: false as const,
        retryable: true,
        error: "resend batch: missing id in response",
      };
    });
  }

  async parseWebhook(req: Request, _env: AppEnv): Promise<WebhookResult> {
    const body = await req.text();
    const id = req.headers.get("svix-id");
    const timestamp = req.headers.get("svix-timestamp");
    const signature = req.headers.get("svix-signature");

    if (!this.webhookSecret || !id || !timestamp || !signature) {
      return reject(400, "missing signature headers");
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_S) {
      return reject(400, "stale timestamp");
    }
    const valid = await verifySvixSignature(this.webhookSecret, id, timestamp, body, signature);
    if (!valid) {
      return reject(401, "invalid signature");
    }

    return { events: parseResendEvents(body), response: new Response("ok", { status: 200 }) };
  }
}

function reject(status: number, message: string): WebhookResult {
  return { events: [], response: new Response(message, { status }) };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** `<sendId>-<sha256(sorted recipient emails)>` — deterministic per chunk. */
async function chunkIdempotencyKey(prefix: string, recipients: Recipient[]): Promise<string> {
  const emails = recipients
    .map((r) => r.email)
    .sort()
    .join(",");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(emails));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 32)}`;
}

// --- Svix signature verification --------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/**
 * Svix scheme: sign `${id}.${timestamp}.${body}` with HMAC-SHA256 keyed by the
 * base64-decoded body of the `whsec_...` secret, base64-encode, and compare
 * (constant-time) against each `v1,<sig>` entry in the space-delimited header.
 */
export async function verifySvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
  header: string,
): Promise<boolean> {
  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = `${id}.${timestamp}.${body}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = bytesToBase64(new Uint8Array(mac));

  const candidates = header
    .split(" ")
    .map((part) => {
      const comma = part.indexOf(",");
      return comma === -1 ? null : { version: part.slice(0, comma), sig: part.slice(comma + 1) };
    })
    .filter((p): p is { version: string; sig: string } => p !== null && p.version === "v1");

  for (const c of candidates) {
    if (await timingSafeEqual(expected, c.sig)) {
      return true;
    }
  }
  return false;
}

/** Sign a body with a `whsec_` secret — the exact bytes a Svix sender produces. */
export async function signSvix(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${bytesToBase64(new Uint8Array(mac))}`;
}

// --- Resend event parsing ----------------------------------------------------

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
    reason?: string;
  };
}

function firstRecipient(to: string[] | string | undefined): string | undefined {
  if (Array.isArray(to)) {
    return to[0];
  }
  return typeof to === "string" ? to : undefined;
}

/**
 * Normalize a single Resend webhook body into DeliveryEvent[]. Unknown event
 * types (opens, clicks, delivery_delayed, ...) yield no events — we only record
 * terminal delivery outcomes.
 */
export function parseResendEvents(body: string): DeliveryEvent[] {
  let evt: ResendEvent;
  try {
    evt = JSON.parse(body) as ResendEvent;
  } catch {
    return [];
  }
  const data = evt.data ?? {};
  const providerId = data.email_id;
  const email = firstRecipient(data.to);

  switch (evt.type) {
    case "email.delivered":
      return [{ type: "delivered", providerId, email }];
    case "email.bounced": {
      // Resend marks permanent failures as a hard bounce; transient ones are
      // reported as delivery_delayed, not bounced — so default to hard.
      const bounceType = data.bounce?.type ?? "";
      const hard = bounceType.toLowerCase() !== "transient";
      const detail = data.bounce?.message ?? data.bounce?.subType;
      return [{ type: "bounced", providerId, email, hard, detail }];
    }
    case "email.complained":
      return [{ type: "complained", providerId, email, detail: data.reason }];
    default:
      return [];
  }
}
