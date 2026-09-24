/**
 * Resend transport adapter. Mirrors FakeProvider's structure; talks to the REST
 * API with `fetch` (no SDK). Two responsibilities behind the seam:
 *
 *   sendBatch    — POST /emails/batch, one object per recipient with the
 *                  unsubscribe sentinel substituted and RFC 8058 one-click
 *                  List-Unsubscribe headers. The Idempotency-Key is the send
 *                  loop's dispatch key, saved with the batch and re-sent with it
 *                  unchanged, so Resend dedupes a re-sent batch instead of
 *                  double-mailing (idempotentRetry). The batch is validated
 *                  permissively, so an invalid item fails alone and the rest are
 *                  sent (`mapBatchResponse`). An error response is about the
 *                  batch as a whole: a halt when it is about Resend or the
 *                  account (`classifyResendError`), and otherwise a permanent
 *                  failure for every recipient in it.
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
  BatchHalt,
  DeliveryEvent,
  EmailProvider,
  HaltCause,
  PerRecipientResult,
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
  WebhookResult,
} from "./types";

const BATCH_URL = "https://api.resend.com/emails/batch";
/** Resend caps a batch send at 100 messages. */
const MAX_BATCH = 100;
/** Reject a webhook whose Svix timestamp is more than this far from now. */
const WEBHOOK_TOLERANCE_S = 5 * 60;
/** How long Resend remembers an idempotency key (24 hours), less a margin for clock skew
 *  and a slow tick. */
const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Error names that are about the API key rather than the request, whatever the status. */
const CREDENTIAL_ERROR_NAMES = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_permission",
]);
/** A spent sending quota: it may lift on its own (daily) or not (monthly), but either way
 *  the operator should know the newsletter is waiting on it. */
const QUOTA_ERROR_NAMES = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

/**
 * Whether a Resend error response halts the batch, and why; null when it is a permanent
 * failure of this batch's own content, recorded against its recipients.
 *
 * Needs the operator: every 401 and 403, which are about the key (missing, revoked,
 * restricted, suspended) or the sender (an unverified domain, or sandbox sending, which
 * Resend reports as a 403 `validation_error`); a 422 `invalid_from_address`, a sender
 * misconfigured in the deployment; and a spent daily or monthly quota. Only waiting
 * helps: any other 429 (a rate limit), a 5xx, and a concurrent request under the same
 * idempotency key. Of those, only the 5xx and the concurrent request may come after
 * Resend did the work, so only they leave the batch's fate unknown.
 */
export function classifyResendError(
  status: number,
  name: string,
  message = "",
): Omit<BatchHalt, "error"> | null {
  const account = (cause: HaltCause) => ({ reason: "account" as const, cause, mayHaveSent: false });
  if (QUOTA_ERROR_NAMES.has(name)) {
    return account("quota");
  }
  if (name === "suspended_api_key") {
    return account("suspended");
  }
  if (CREDENTIAL_ERROR_NAMES.has(name) || status === 401) {
    return account("credentials");
  }
  if (name === "invalid_from_address" || (status === 403 && name === "validation_error")) {
    return account("sender");
  }
  if (status === 403) {
    return account(/domain|testing emails/i.test(message) ? "sender" : "credentials");
  }
  if (status === 429) {
    return { reason: "unavailable", cause: "rate_limit", mayHaveSent: false };
  }
  if (status >= 500 || name === "concurrent_idempotent_requests") {
    return { reason: "unavailable", cause: "outage", mayHaveSent: true };
  }
  return null;
}

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
  readonly idempotencyWindowMs = IDEMPOTENCY_WINDOW_MS;

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
  ): Promise<SendBatchResult> {
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
        // Strict (Resend's default) refuses the whole batch over one invalid item, which
        // would record up to 99 good recipients unsent alongside it. Permissive sends the
        // valid items and lists the invalid ones by index.
        "x-batch-validation": "permissive",
        // The send loop's dispatch key: the same on every re-send of this batch and
        // never reused for another, so a replayed batch is deduped however the rest of
        // the send has changed since. A one-off caller without one gets a key derived
        // from the batch itself.
        "Idempotency-Key":
          opts.idempotencyKey ?? (await chunkIdempotencyKey(opts.idempotencyKeyPrefix, recipients)),
      },
      // The batch endpoint takes the JSON array of email objects as the body.
      body: JSON.stringify(elements),
    });

    if (!res.ok) {
      const text = this.redact(await safeText(res));
      const { name, message } = parseResendError(text);
      // The operator reads this, so it is Resend's name and message, not its raw JSON.
      const error = message
        ? `Resend ${res.status}${name ? ` ${name}` : ""}: ${message}`
        : `Resend ${res.status}: ${text}`;
      const halt = classifyResendError(res.status, name, message);
      if (halt) {
        return { kind: "halted", halt: { ...halt, error } };
      }
      return {
        kind: "answered",
        results: recipients.map((r) => ({
          email: r.email,
          accepted: false as const,
          retryable: false,
          error,
        })),
      };
    }

    const body: unknown = await res.json().catch(() => ({}));
    return { kind: "answered", results: mapBatchResponse(recipients, body) };
  }

  /** An error body is shown to the operator, so it never carries the key, even echoed. */
  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
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

/**
 * Each recipient's own outcome from a permissive batch's 2xx body. `errors` names the
 * refused items by their index in the request, and a refused item is permanent for that
 * recipient alone. `data` holds the created emails' ids in request order. Resend's
 * SDKs show it leaving the refused items out, but its docs don't say so, so both
 * layouts are read: one entry per created email, or one per request item, read by
 * position (the two agree when nothing is refused). When neither count fits, which id
 * is whose is a guess, so every recipient not refused is left retryable: the batch's
 * idempotency key makes the re-send safe (I4).
 */
function mapBatchResponse(recipients: Recipient[], body: unknown): PerRecipientResult[] {
  const { data = [], errors = [] } =
    typeof body === "object" && body !== null ? (body as { data?: unknown; errors?: unknown }) : {};
  const ids = Array.isArray(data) ? data.map((d) => (typeof d?.id === "string" ? d.id : "")) : [];
  const refused = new Map<number, string>();
  for (const e of Array.isArray(errors) ? errors : []) {
    if (Number.isInteger(e?.index) && e.index >= 0 && e.index < recipients.length) {
      refused.set(e.index, typeof e.message === "string" ? e.message : "");
    }
  }
  const positional = ids.length === recipients.length;
  const compacted = ids.length === recipients.length - refused.size;
  let next = 0;
  return recipients.map((r, i) => {
    if (refused.has(i)) {
      const message = refused.get(i);
      return {
        email: r.email,
        accepted: false as const,
        retryable: false,
        error: `Resend: ${message || "refused in batch validation"}`,
      };
    }
    const id = positional ? ids[i] : compacted ? ids[next++] : undefined;
    if (id) {
      return { email: r.email, accepted: true as const, providerId: id };
    }
    // A 2xx without an id we can match to this recipient is ambiguous: let the next tick
    // retry under the same key.
    return {
      email: r.email,
      accepted: false as const,
      retryable: true,
      error: "resend batch: missing id in response",
    };
  });
}

function reject(status: number, message: string): WebhookResult {
  return { events: [], response: new Response(message, { status }) };
}

/** The `name` and `message` of a Resend error body (best effort; empty when absent). */
function parseResendError(text: string): { name: string; message: string } {
  try {
    const body = JSON.parse(text) as { name?: unknown; message?: unknown };
    return {
      name: typeof body.name === "string" ? body.name : "",
      message: typeof body.message === "string" ? body.message : "",
    };
  } catch {
    return { name: "", message: "" };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** `<prefix>-<sha256(sorted recipient emails)>`, for a one-off batch that brings no key
 *  of its own. Never the send loop's: a hash of the batch's composition changes when the
 *  batch is re-made differently, which is exactly the retry it would have to dedupe. */
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
