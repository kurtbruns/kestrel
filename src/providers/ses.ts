/**
 * Amazon SES adapter (SESv2 SendBulkEmail over HTTPS, SigV4-signed with aws4fetch).
 *
 * Sending: a list send's batch is one SendBulkEmail request, to the SESv2
 * `outbound-bulk-emails` endpoint. The frozen render goes once, as an inline template
 * (ses_template.ts), and each recipient as an entry with its own template data (its
 * unsubscribe URL and address, as the render's delivery pass fills them) and its own RFC
 * 8058 one-click headers. A test, a confirmation, and a notification go as one SendEmail
 * a recipient with the same template, data, and headers, so a test is the send (I5), and
 * they stay off SendBulkEmail's throttle, which the send loop uses to the full.
 *
 * Throughput: a request takes up to 50 destinations, but SES throttles every action but its
 * single sends to one request a second, and counts each destination against the account's
 * maximum send rate. So a batch is the send rate's worth of recipients, up to 50, and the
 * send loop starts one request a second (`sesTraits`).
 *
 * Idempotency: SESv2 has NO idempotency key, and the send loop never re-sends a request
 * that got no answer: such a batch stays `dispatched` for a human (Resolve). At-most-once
 * (I4) is upheld by never re-dispatching, not by dedupe. A request lost in flight leaves
 * its whole batch for Resolve.
 *
 * Failures: SES answers a request either with an error that speaks for all of it, or with
 * one result an entry. An error, or an entry status, that is about SES, the account, or the
 * email rather than the recipient (`classifySesError`, `classifySesEntry`) halts the batch
 * when nothing in it was accepted, and otherwise sends those recipients back to wait for the
 * next tick, so no failure that isn't a recipient's is recorded against one (SPEC §12). A
 * server error is treated as no answer, since AWS says one can follow a request SES took.
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
import { haltRank } from "../../shared/sends";
import type { AppEnv, Config } from "../env";
import { log } from "../lib/log";
import { unwrap } from "../lib/unwrap";
import {
  type SesTemplateContent,
  sesAddressProblem,
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

/** Error types that are about the account, its credentials, or the deployment, never a
 *  recipient, by what has to be fixed and who fixes it (`refusalAdvice`). */
const ACCOUNT_ERROR_TYPES = new Map<string, HaltCause>([
  // AWS restricted the account's sending for good, over its sending practices.
  ["AccountSuspendedException", "suspended"],
  // Sending is paused: by AWS under review, or turned off by hand (`sendingPaused` tells a
  // configuration set's pause apart by SES's words).
  ["SendingPausedException", "paused"],
  // SES's API reference says the sending domain isn't verified, its troubleshooting page that
  // it can't read the custom MAIL FROM domain's MX record; the advice names both.
  ["MailFromDomainNotVerifiedException", "mail_from"],
  // A resource the request names doesn't exist. Kestrel names only its configuration set
  // (SES_CONFIGURATION_SET), so this is a typo, a set deleted after setup, or the wrong
  // region: the deployment's to fix, and the same for every recipient, so it holds the send
  // rather than marking each one failed. Without a configuration set the request names no
  // resource that could be missing, so a 404 then isn't expected, and the advice still points
  // at the one setting that would cause it.
  ["NotFoundException", "configuration"],
  // An action SES doesn't know: the request and the endpoint disagree.
  ["UnknownOperationException", "unsupported"],
  // A request SES couldn't parse as HTTP is Kestrel's to fix, never a recipient's.
  ["MalformedHttpRequestException", "unsupported"],
  // The AWS account isn't signed up for SES, which the key can't change.
  ["OptInRequired", "opt_in"],
  // The credentials themselves: unknown, wrongly signed, expired, or not permitted (a key
  // whose policy lacks `ses:SendBulkEmail` among them).
  ["UnrecognizedClientException", "credentials"],
  ["InvalidClientTokenId", "credentials"],
  ["SignatureDoesNotMatch", "credentials"],
  ["IncompleteSignature", "credentials"],
  ["ExpiredTokenException", "credentials"],
  ["AccessDeniedException", "credentials"],
  ["NotAuthorized", "credentials"],
  // The request as a whole is too large: the email itself, the same for every batch of it.
  ["RequestEntityTooLargeException", "content"],
]);

/** Error types that say SES didn't take the request for a reason of its own that the next
 *  request may not meet: it never received the whole request (408), or it limits a resource
 *  for now (`LimitExceededException`, which AWS describes only as too many of one). */
const UNAVAILABLE_ERROR_TYPES = new Set(["RequestTimeoutException", "LimitExceededException"]);

/**
 * Error types after which SES's answer leaves the request's fate unknown, as no answer does
 * (the caller throws, and the send loop leaves the batch for Resolve, I4): AWS says a
 * request it aborted ended "before a response could be returned", not that it was never
 * acted on.
 */
const UNKNOWN_FATE_ERROR_TYPES = new Set(["RequestAbortedException"]);

/** Whether an SES error response leaves the request's fate unknown (`UNKNOWN_FATE_ERROR_TYPES`,
 *  or a 5xx, which AWS says can follow a request it already accepted). */
export function sesFateUnknown(status: number, type: string): boolean {
  return status >= 500 || UNKNOWN_FATE_ERROR_TYPES.has(type);
}

/**
 * The identities SES's "not verified" words name, lowercased, or null when the words aren't
 * that refusal. SES says "Email address is not verified. The following identities failed the
 * check in region R: id1, id2, …", ending in an ellipsis when it can't list them all, and an
 * identity is the sender's address or domain or, while the account is in the sandbox, a
 * recipient's address.
 */
export function unverifiedIdentities(message: string): string[] | null {
  if (!/not verified/i.test(message)) {
    return null;
  }
  const list = /failed the check in region[^:]*:(.*)$/is.exec(message)?.[1] ?? "";
  return list
    .split(",")
    .map((id) =>
      id
        .trim()
        .replace(/(\.\.\.|…|\.)$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * Whether an identity SES names is this deployment's sender: its exact address, or a domain
 * identity that covers it (its own domain or a parent of it). Never a substring of the
 * address, so a reader `thenews@example.com` is never taken for the sender `news@example.com`.
 */
export function isSenderIdentity(identity: string, from: string): boolean {
  const address = bareAddress(from);
  if (identity.includes("@")) {
    return identity === address;
  }
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return identity === domain || domain.endsWith(`.${identity}`);
}

/**
 * Whose a "not verified" refusal is: the sender's, when SES names the sender's identity
 * (a sending identity that lapsed, or the wrong region), else the account's sandbox, which
 * mails only verified addresses and names the recipients it refused. Null when the words
 * aren't that refusal. With no identity readable in the words, it is the sender's: only the
 * sender's identity is checked outside the sandbox.
 */
export function verificationCause(message: string, from: string): "sender" | "sandbox" | null {
  const ids = unverifiedIdentities(message);
  if (ids === null) {
    return null;
  }
  if (ids.length === 0 || ids.some((id) => isSenderIdentity(id, from))) {
    return "sender";
  }
  return "sandbox";
}

/**
 * Whether an SES error response halts the batch, and why; null when it may be about a
 * recipient (an invalid request, a bad address), which the caller weighs by how many
 * recipients the request carried. The account-level types and any 401 or 403, a 404 (a
 * configuration set SES can't find, whatever type it carries), and a "not verified" refusal
 * (`verificationCause`: the sender's identity, or the sandbox refusing recipients) need
 * whoever runs the deployment, as does a spent daily quota, which SES reports as a throttle
 * or a limit and tells apart only by its words: it won't lift for up to a day. Any other
 * rejected message is a refusal of the email itself (`content`), the same for every batch of
 * it, so it holds the send rather than working through the list. Any other throttling (a
 * 429, or a throttling type on a 400), a request SES never received whole (408), a limit, and
 * a 5xx are SES being unavailable: the batch waits for its retry. A 5xx may follow a request
 * SES accepted, so a list send's caller checks `sesFateUnknown` before this.
 */
export function classifySesError(
  status: number,
  type: string,
  message = "",
  from = "",
): Omit<BatchHalt, "error"> | null {
  const throttled = status === 429 || /throttl|toomany/i.test(type);
  if (
    (throttled || type === "LimitExceededException") &&
    /daily (message|sending) quota/i.test(message)
  ) {
    return account("quota");
  }
  const named = ACCOUNT_ERROR_TYPES.get(type);
  if (named) {
    return account(named === "paused" && /configuration set/i.test(message) ? "set_paused" : named);
  }
  if (type === "MessageRejected") {
    return account(verificationCause(message, from) ?? "content");
  }
  if (status === 404) {
    return account("configuration");
  }
  if (status === 401 || status === 403) {
    return account("credentials");
  }
  if (throttled) {
    return unavailable("rate_limit");
  }
  if (status === 408 || UNAVAILABLE_ERROR_TYPES.has(type) || status >= 500) {
    return unavailable("outage");
  }
  return null;
}

function account(cause: HaltCause): Omit<BatchHalt, "error"> {
  return { reason: "account", cause };
}
function unavailable(cause: HaltCause): Omit<BatchHalt, "error"> {
  return { reason: "unavailable", cause };
}

/** Entry statuses that are about SES, the account, or the deployment's settings, never the
 *  recipient. A configuration set or sending pool SES can't find is the deployment's to fix,
 *  in its settings, not the key's; a template Kestrel never names is the request and the
 *  endpoint disagreeing. */
const ENTRY_HALTS = new Map<string, Omit<BatchHalt, "error">>([
  ["ACCOUNT_SUSPENDED", account("suspended")],
  ["ACCOUNT_SENDING_PAUSED", account("paused")],
  ["CONFIGURATION_SET_SENDING_PAUSED", account("set_paused")],
  ["MAIL_FROM_DOMAIN_NOT_VERIFIED", account("mail_from")],
  ["ACCOUNT_DAILY_QUOTA_EXCEEDED", account("quota")],
  ["CONFIGURATION_SET_DOES_NOT_EXIST", account("configuration")],
  ["CONFIGURATION_SET_NOT_FOUND", account("configuration")],
  ["INVALID_SENDING_POOL_NAME", account("sending_pool")],
  ["TEMPLATE_DOES_NOT_EXIST", account("unsupported")],
  ["TEMPLATE_NOT_FOUND", account("unsupported")],
  ["ACCOUNT_THROTTLED", unavailable("rate_limit")],
  ["TRANSIENT_FAILURE", unavailable("outage")],
]);

/** Entry statuses that are the recipient's own: an invalid parameter (its address) is
 *  permanent, and `FAILED`, which AWS leaves unexplained, is retried a bounded number of
 *  times like any recipient's own transient error. */
const ENTRY_RECIPIENT_FAILURES = new Map<string, { retryable: boolean }>([
  ["INVALID_PARAMETER", { retryable: false }],
  ["INVALID_PARAMETER_VALUE", { retryable: false }],
  ["FAILED", { retryable: true }],
]);

/** What one entry's failed result means for its recipient. */
export type EntryVerdict =
  /** About SES or the account: the recipient is held back with no attempt spent. */
  | { kind: "halt"; halt: Omit<BatchHalt, "error"> }
  /** The recipient's own failure, permanent unless `retryable`, unless SES answered more
   *  than one entry so and took none, which makes it the request's (`sendBulk`). */
  | { kind: "recipient"; retryable: boolean }
  /** SES rejected the message for this entry: the email's, unless SES took another entry
   *  of the request or named this recipient (`sendBulk`). */
  | { kind: "rejected" }
  /** A status SES doesn't document, or none: whether it took the message is unknown. */
  | { kind: "unknown" };

/**
 * What one entry's failed result means. A status SES doesn't document, or none at all, says
 * neither that the recipient failed nor that SES didn't take the message (an entry's status
 * and message id are both optional), so its fate is unknown, as a missing result's is.
 */
export function classifySesEntry(status: string, words = "", from = ""): EntryVerdict {
  const halt = ENTRY_HALTS.get(status);
  if (halt) {
    return { kind: "halt", halt };
  }
  if (status === "MESSAGE_REJECTED") {
    const verification = verificationCause(words, from);
    return verification ? { kind: "halt", halt: account(verification) } : { kind: "rejected" };
  }
  const own = ENTRY_RECIPIENT_FAILURES.get(status);
  if (own) {
    return { kind: "recipient", retryable: own.retryable };
  }
  return { kind: "unknown" };
}

interface BulkEntryResult {
  Status?: string;
  MessageId?: string;
  Error?: string;
}

/** A batch's halt, or the halt that outranks it (`haltRank`): an account refusal is the one
 *  the publisher has to act on, so it wins over a provider that is only unavailable, and
 *  one the account's other sends wait on wins over one send's own. */
function worse(a: BatchHalt | null, b: BatchHalt): BatchHalt {
  return !a || haltRank(b) > haltRank(a) ? b : a;
}

export class SesProvider implements EmailProvider {
  readonly name = "ses" as const;
  readonly maxBatch: number;
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

  private endpoint(path: "outbound-emails" | "outbound-bulk-emails"): string {
    return `https://email.${this.region}.amazonaws.com/v2/email/${path}`;
  }

  /**
   * A list send's batch goes as SendBulkEmail requests of up to `maxBatch`. A test, a
   * confirmation, or a notification goes as one SendEmail a recipient with the same inline
   * template and data, so it is the same email (I5), and stays off SendBulkEmail's
   * one-request-a-second throttle, which the send loop's requests use to the full.
   */
  async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const out: PerRecipientResult[] = [];
    const sendable: Recipient[] = [];
    for (const r of recipients) {
      const problem = sesAddressProblem(r.email);
      if (problem === null) {
        sendable.push(r);
      } else {
        // SES refuses such an address for the whole request, so it stays out of it and
        // fails alone.
        out.push({ email: r.email, accepted: false, retryable: false, error: problem });
      }
    }
    const content = sesTemplateContent(rendered);
    const size = opts.purpose === "list" ? this.maxBatch : 1;
    let held: BatchHalt | null = null;
    for (let at = 0; at < sendable.length; at += size) {
      const batch = sendable.slice(at, at + size);
      let answer: SendBatchResult;
      try {
        answer =
          opts.purpose === "list"
            ? await this.sendBulk(content, batch)
            : await this.sendSingle(content, unwrap(batch[0], "a recipient"));
      } catch (err) {
        // A request with no answer. On the first, it is the caller's to handle (the send
        // loop leaves the batch for Resolve). After it, a one-off caller (a template test to
        // several addresses) gets the answers it already has: this recipient's fate is
        // unknown, and the rest were never sent. A list batch always throws, so the send
        // loop leaves every recipient whose fate is unknown in flight (I4).
        if (opts.purpose === "list" || (at === 0 && out.length === 0)) {
          throw err;
        }
        const words = err instanceof Error ? err.message : String(err);
        for (const r of batch) {
          out.push({
            email: r.email,
            accepted: false,
            retryable: false,
            error: `ses gave no answer (${words}), so it may have arrived`,
          });
        }
        for (const rest of sendable.slice(at + size)) {
          out.push({ email: rest.email, accepted: false, retryable: true, error: "not sent" });
        }
        break;
      }
      if (answer.kind === "halted") {
        // A refusal on the first request, with nothing else answered, speaks for the whole
        // batch. Later, it can't: the rest are held back, and wait for the next tick.
        if (at === 0 && out.length === 0) {
          return answer;
        }
        held = worse(held, answer.halt);
        for (const rest of sendable.slice(at)) {
          out.push({
            email: rest.email,
            accepted: false,
            retryable: true,
            error: answer.halt.error,
            held: true,
          });
        }
        break;
      }
      out.push(...answer.results);
      if (answer.halt) {
        held = worse(held, answer.halt);
        for (const rest of sendable.slice(at + size)) {
          out.push({
            email: rest.email,
            accepted: false,
            retryable: true,
            error: answer.halt.error,
            held: true,
          });
        }
        break;
      }
    }
    return held
      ? { kind: "answered", results: out, halt: held }
      : { kind: "answered", results: out };
  }

  /** The one-click unsubscribe headers for a recipient with an unsubscribe link; none for
   *  a confirmation or a notification, which carry none. */
  private unsubscribeHeaders(r: Recipient): { Name: string; Value: string }[] {
    return r.unsubscribeUrl
      ? [
          { Name: "List-Unsubscribe", Value: `<${r.unsubscribeUrl}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ]
      : [];
  }

  private templateData(r: Recipient): string {
    return JSON.stringify(
      sesTemplateData({ ".Email.UnsubscribeURL": r.unsubscribeUrl, ".Email.SentTo": r.email }),
    );
  }

  /**
   * POST one request to SES. A transport error (no HTTP response) is AMBIGUOUS: SES may or
   * may not have accepted it. SES has no idempotency key, so it must never be re-sent
   * (that risks a duplicate, violating I4): it throws, and the send loop leaves its
   * recipients `dispatched` for a human. A request SES never answers is ended the same
   * way: the timeout rejects the fetch, so it throws down that same path. aws4fetch
   * carries `signal` onto the signed Request. An HTTP error response says SES did not
   * accept, except a 5xx or an aborted request (`sesFateUnknown`), which a list send treats
   * as no answer.
   */
  private post(
    path: "outbound-emails" | "outbound-bulk-emails",
    payload: Record<string, unknown>,
  ): Promise<Response> {
    if (this.configurationSet) {
      payload.ConfigurationSetName = this.configurationSet;
    }
    return this.client.fetch(this.endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  }

  /** An SES error response: its type, its halt, or SES's words when it may be about a
   *  recipient. */
  private async refusal(
    res: Response,
  ): Promise<{ type: string; halt: BatchHalt | null; error: string }> {
    const bodyText = await res.text().catch(() => "");
    const { type, message } = parseSesError(bodyText, res.headers.get("x-amzn-ErrorType"));
    const error = sesErrorText(res.status, type, message);
    const halt = classifySesError(res.status, type, message, this.from);
    return { type, halt: halt ? { ...halt, error } : null, error };
  }

  /** One SendEmail with the inline template, for a one-off message to one recipient. */
  private async sendSingle(content: SesTemplateContent, r: Recipient): Promise<SendBatchResult> {
    const res = await this.post("outbound-emails", {
      FromEmailAddress: sesFromAddress(this.from),
      Destination: { ToAddresses: [r.email] },
      Content: {
        Template: {
          TemplateContent: content,
          TemplateData: this.templateData(r),
          Headers: this.unsubscribeHeaders(r),
        },
      },
    });
    if (res.ok) {
      let providerId = "";
      try {
        providerId = ((await res.json()) as { MessageId?: string }).MessageId ?? "";
      } catch {
        /* a 200 with an unreadable body still means accepted */
      }
      return { kind: "answered", results: [{ email: r.email, accepted: true, providerId }] };
    }
    const { halt, error } = await this.refusal(res);
    return halt
      ? { kind: "halted", halt }
      : {
          kind: "answered",
          results: [{ email: r.email, accepted: false, retryable: false, error }],
        };
  }

  /** One SendBulkEmail request for up to `maxBatch` recipients of a list send. */
  private async sendBulk(
    content: SesTemplateContent,
    batch: Recipient[],
  ): Promise<SendBatchResult> {
    const res = await this.post("outbound-bulk-emails", {
      FromEmailAddress: sesFromAddress(this.from),
      // Every entry carries all of its data, so the default is empty: an entry SES read
      // without its own data would fail to render rather than go out with someone else's.
      DefaultContent: { Template: { TemplateContent: content, TemplateData: "{}" } },
      BulkEmailEntries: batch.map((r) => ({
        Destination: { ToAddresses: [r.email] },
        ReplacementEmailContent: {
          ReplacementTemplate: { ReplacementTemplateData: this.templateData(r) },
        },
        ReplacementHeaders: this.unsubscribeHeaders(r),
      })),
    });

    if (!res.ok) {
      const { type, halt, error } = await this.refusal(res);
      // AWS says a server error or a timeout can follow a request SES already accepted, and
      // a retry then mails a second copy, so such an answer is no answer: it throws, and the
      // send loop leaves the batch for Resolve (I4).
      if (sesFateUnknown(res.status, type)) {
        throw new Error(`${error} (SES may have taken the batch before answering)`);
      }
      if (halt) {
        return { kind: "halted", halt };
      }
      return this.invalidBatch(batch, error);
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
    // Failures that are the recipient's only if SES's answer singles them out.
    const rejected: { email: string; error: string }[] = [];
    const own: { email: string; error: string; status: string; retryable: boolean }[] = [];
    let halt: BatchHalt | null = null;
    let short = false;
    for (const [i, r] of batch.entries()) {
      const entry = entries[i];
      if (!entry) {
        short = true;
        continue;
      }
      const status = entry.Status ?? "";
      if (status === "SUCCESS") {
        results.push({ email: r.email, accepted: true, providerId: entry.MessageId ?? "" });
        continue;
      }
      const words = entry.Error ?? "";
      const error = sesEntryErrorText(status || "no status", words);
      const verdict = classifySesEntry(status, words, this.from);
      if (verdict.kind === "unknown") {
        // Left out like a missing result, so it waits for Resolve: never re-sent (I4), and
        // never recorded unsent on a guess.
        log.warn("provider.unrecognized", { provider: "ses", status: status || null, error });
        short = true;
      } else if (verdict.kind === "halt") {
        halt = worse(halt, { ...verdict.halt, error });
        heldBack.push({ email: r.email, error });
      } else if (namesAddress(words, r.email)) {
        // SES's words name this recipient: theirs, whatever else the answer says.
        results.push({ email: r.email, accepted: false, retryable: false, error });
      } else if (verdict.kind === "rejected") {
        rejected.push({ email: r.email, error });
      } else {
        own.push({ email: r.email, error, status, retryable: verdict.retryable });
      }
    }
    const tookAny = results.some((r) => r.accepted);
    // SES rejecting the message, with nothing in the request taken, is a refusal of the email
    // itself, the same for every batch of it, so it holds the send for whoever runs the
    // deployment rather than working through the list (AWS documents MESSAGE_REJECTED only
    // for content). A rejection beside a recipient SES took is that recipient's alone.
    if (rejected.length > 0 && !tookAny) {
      halt = worse(halt, {
        reason: "account",
        cause: "content",
        error: unwrap(rejected[0], "a rejection").error,
      });
      heldBack.push(...rejected);
    } else {
      for (const r of rejected) {
        results.push({ email: r.email, accepted: false, retryable: false, error: r.error });
      }
    }
    // An invalid parameter or a plain failure on several entries, with nothing taken, is the
    // request's rather than each recipient's: the parameters every entry shares, or SES
    // itself. It holds the batch, as an invalid batch or an outage, rather than mark it unsent.
    for (const r of own) {
      const alike = own.filter((o) => o.status === r.status).length;
      if (alike > 1 && !tookAny) {
        halt = worse(halt, {
          ...(r.status === "FAILED" ? unavailable("outage") : account("invalid_request")),
          error: r.error,
        });
        heldBack.push({ email: r.email, error: r.error });
      } else {
        results.push({ email: r.email, accepted: false, retryable: r.retryable, error: r.error });
      }
    }
    // The request speaks as a whole only when SES answered every recipient and took none:
    // a recipient it left out may have been mailed, and must stay in flight (I4).
    if (halt && !short && !results.some((r) => r.accepted)) {
      return { kind: "halted", halt };
    }
    if (!halt) {
      return { kind: "answered", results };
    }
    // The recipients SES held back for its own reasons go back to the queue with no
    // attempt spent, and the send records why.
    for (const h of heldBack) {
      results.push({
        email: h.email,
        accepted: false,
        retryable: true,
        error: h.error,
        held: true,
      });
    }
    return { kind: "answered", results, halt };
  }

  /**
   * A list batch SES refused as invalid, for a reason that may be one recipient's (a bad
   * address SES's syntax check refuses) rather than the email's. A batch of one is that
   * recipient's own, permanently. In a larger batch, a recipient SES's words name is
   * refused alone and the rest go back to the queue, untouched, for the next request; with
   * no one named, no one can be blamed, so the send holds for a person to read SES's words
   * (`invalid_request`), rather than mark a whole batch unsent for one address.
   */
  private invalidBatch(batch: Recipient[], error: string): SendBatchResult {
    if (batch.length === 1) {
      const only = unwrap(batch[0], "a recipient");
      return {
        kind: "answered",
        results: [{ email: only.email, accepted: false, retryable: false, error }],
      };
    }
    const named = batch.filter((r) => namesAddress(error, r.email));
    if (named.length === 0) {
      return { kind: "halted", halt: { reason: "account", cause: "invalid_request", error } };
    }
    return {
      kind: "answered",
      results: batch.map((r) =>
        named.includes(r)
          ? { email: r.email, accepted: false, retryable: false, error }
          : { email: r.email, accepted: false, retryable: true, error: "not sent", held: true },
      ),
    };
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

/** Characters that can stand next to an address inside it, so a match beside one is part of
 *  a longer address, not this one. */
const ADDRESS_CHAR = /[a-z0-9.!#$%&'*+/=?^_`{|}~@-]/i;

/** Whether SES's words name this exact address, never as part of a longer one (`thenews@`
 *  holds `news@` inside it). A sentence's closing period after it still counts. */
export function namesAddress(words: string, email: string): boolean {
  const text = words.toLowerCase();
  const target = email.toLowerCase();
  for (let at = text.indexOf(target); at >= 0; at = text.indexOf(target, at + 1)) {
    const before = text[at - 1];
    const after = text.slice(at + target.length, at + target.length + 2);
    const endsHere = after === "" || !ADDRESS_CHAR.test(after[0] ?? "") || /^\.(\s|$)/.test(after);
    if ((before === undefined || !ADDRESS_CHAR.test(before)) && endsHere) {
      return true;
    }
  }
  return false;
}
