// Sends as the API carries them (SPEC §6, §8, §12): one `SendView` of a send, the same on
// every route (the list, the send, the feed, and every action's answer), the feed the pages
// follow, and the per-recipient record; beside them, the stored send row the Worker builds
// the view from, which never goes on the wire as it is.
// The Worker's routes produce these shapes and the editor consumes them; one definition,
// so neither can drift.

import { DAILY_WRITES_BUDGET, SEND_WRITES_PER_RECIPIENT, type WritesDay } from "./daily_writes";
import type { PageMeta } from "./list";

export type SendStatus = "scheduled" | "sending" | "sent" | "canceled";

/**
 * Why a provider refused a whole batch (SPEC §12): it is `unavailable` (an outage or a
 * rate limit, which clears on its own), or it refuses the `account` (a bad key, an
 * unverified domain, a paused account), which needs the operator.
 */
export type HaltReason = "unavailable" | "account";

/**
 * What a refusal is about, so the advice can name the fix and who makes it (SPEC §12): the
 * access key or its permissions (`credentials`), an AWS account not signed up for the
 * provider (`opt_in`), a deployment setting naming something the provider can't find (an SES
 * configuration set, `configuration`, or the dedicated IP pool one names, `sending_pool`), a
 * request the provider reads as naming something Kestrel never sends (`unsupported`), the
 * sender's identity (`sender`) or its custom MAIL FROM domain (`mail_from`), an account still
 * in the provider's sandbox, which mails only verified addresses (`sandbox`), a spent sending
 * quota, the account shut down (`suspended`), its sending paused (`paused`) or a
 * configuration set's (`set_paused`), the email's content (`content`) or a batch the provider
 * reads as invalid (`invalid_request`), which are one send's alone, a rate limit, the
 * provider itself failing (`outage`), or no provider connected to the deployment at all
 * (SPEC §9).
 */
export type HaltCause =
  | "credentials"
  | "opt_in"
  | "configuration"
  | "sending_pool"
  | "unsupported"
  | "sender"
  | "mail_from"
  | "sandbox"
  | "quota"
  | "suspended"
  | "paused"
  | "set_paused"
  | "content"
  | "invalid_request"
  | "rate_limit"
  | "outage"
  | "not_connected";

/**
 * The refusals that are about one send rather than the account (SPEC §12): the provider
 * refuses that send's email, or a batch of it, and would take another send's. No other send
 * waits on one, and its words say "this send" rather than "the account".
 */
export const SEND_OWN_HALT_CAUSES: readonly HaltCause[] = ["content", "invalid_request"];

/** Whether a refusal is the send's own rather than the account's (`SEND_OWN_HALT_CAUSES`). */
export function isSendOwnHalt(cause: HaltCause | null): boolean {
  return cause !== null && SEND_OWN_HALT_CAUSES.includes(cause);
}

/**
 * How much a halt outranks another in one run (SPEC §12): a provider only unavailable
 * least, then a refusal of one send's own email, then a refusal of the account, which every
 * other send waits on, so the send records the one the publisher and the other sends must
 * hear.
 */
export function haltRank(halt: { reason: HaltReason; cause: HaltCause | null }): number {
  return halt.reason === "unavailable" ? 0 : isSendOwnHalt(halt.cause) ? 1 : 2;
}

/**
 * The advice for a send held for want of a provider (SPEC §9), in its parts: the setup step,
 * which a page makes the link every not-connected line carries, and what follows it. The
 * guide's mention stands in for that link where there is none (an email, the API's words).
 * "Deploy" is the step's own last one.
 */
export const NOT_CONNECTED_ADVICE = {
  step: "Connect Amazon SES",
  guide: " (the setup guide walks through it)",
  after: ", then deploy.",
} as const;

/**
 * What to do about the provider refusing the account or a send, by what the refusal is about
 * (SPEC §12), and who does it: almost always whoever runs the deployment, in the provider's
 * console or the deployment's settings, since nothing in the app can change a credential or
 * the provider's view of the account (SPEC §9); the publisher, when a subscriber's address
 * explains it. One wording for the watch and the notification that tells the publisher, so
 * the two never advise differently. Plain text: a page that links the not-connected step
 * builds it from `NOT_CONNECTED_ADVICE`.
 */
export function refusalAdvice(cause: HaltCause | null): string {
  switch (cause) {
    case "credentials":
      return "Whoever runs the deployment replaces the SES access key in its secrets, or gives the key ses:SendEmail and ses:SendBulkEmail in its IAM policy.";
    case "opt_in":
      return "The AWS account isn’t signed up for SES: whoever runs the deployment enables SES for the account in the region AWS_REGION names, or settles the account’s activation or billing with AWS.";
    case "configuration":
      return "Whoever runs the deployment checks that the SES_CONFIGURATION_SET secret names a configuration set in the SES region, or creates the set in the SES console.";
    case "sending_pool":
      return "The configuration set SES_CONFIGURATION_SET names sends through a dedicated IP pool SES can’t find: whoever runs the deployment picks an existing pool in the set’s sending options, or removes the pool, in the SES console.";
    case "unsupported":
      return "SES read the request as naming something Kestrel never sends, such as a stored template: whoever runs the deployment checks that AWS_REGION names a region that offers SES, and updates Kestrel.";
    case "sender":
      return "Whoever runs the deployment verifies the From address, or its domain, in SES, in the region AWS_REGION names.";
    case "mail_from":
      return "SES says the sending domain isn’t verified, or it can’t read the sender’s custom MAIL FROM domain’s MX record: whoever runs the deployment checks that the sending domain is verified in the region AWS_REGION names, and checks the MAIL FROM domain’s MX record in DNS or sets the identity’s Behavior on MX failure to use the default MAIL FROM domain, in the SES console.";
    case "sandbox":
      return "The SES account is still in the sandbox, which mails only addresses verified in SES: whoever runs the deployment requests production access on the SES console’s account dashboard. To test before then, verify the reader’s address in SES.";
    case "quota":
      return "SES’s 24-hour quota frees up on its own. In the sandbox (200 a day), whoever runs the deployment requests production access; otherwise they can ask AWS to raise the quota in the Service Quotas console.";
    case "suspended":
      return "AWS has shut down the account’s sending, and only AWS can lift it: whoever runs the deployment opens a case with AWS Support from the SES console.";
    case "paused":
      return "Sending is paused for the SES account. If AWS paused it under review, its email to the AWS account’s address says what to fix; if it was turned off by hand, whoever runs the deployment turns it back on (aws sesv2 put-account-sending-attributes --sending-enabled).";
    case "set_paused":
      return "Sending is turned off on the configuration set SES_CONFIGURATION_SET names, by hand or by an alarm set up on it: whoever runs the deployment turns it back on (aws sesv2 put-configuration-set-sending-options --sending-enabled, naming the set).";
    case "content":
      return "SES refuses this email itself, not a reader or the account, and the email can’t change once its send has started: whoever runs the deployment asks AWS Support what SES refuses in it, quoting SES’s words.";
    case "invalid_request":
      return "SES refused a batch of this send as invalid. If its words name an address, remove that subscriber: the send skips anyone no longer on the list, and resumes at its next retry.";
    case "not_connected":
      return `${NOT_CONNECTED_ADVICE.step}${NOT_CONNECTED_ADVICE.guide}${NOT_CONNECTED_ADVICE.after}`;
    default:
      return "Whoever runs the deployment fixes the account with the provider.";
  }
}

/**
 * How many rate-limit halts in a row, with nothing taken between them, mark a throttle the
 * deployment causes itself (SPEC §12): a burst clears within a second and every retry after
 * the first is minutes out, so a provider that still refuses the first request of each retry
 * is being asked for more a second than the account allows (SES_MAX_SEND_RATE above it).
 */
export const SELF_THROTTLE_HALTS = 3;

/** Whether a send's halt is a rate limit that has outlasted any burst (`SELF_THROTTLE_HALTS`). */
export function isSelfThrottled(
  send: Pick<Send, "halt_reason" | "halt_cause" | "halt_retries">,
): boolean {
  return (
    send.halt_reason === "unavailable" &&
    send.halt_cause === "rate_limit" &&
    send.halt_retries >= SELF_THROTTLE_HALTS
  );
}

/** The provider's words as a sentence the copy around them can follow. */
export function sentence(error: string | null): string {
  const text = error?.trim() || "no detail given";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The `refused` condition's words (SPEC §12), by whose refusal it is: no provider connected,
 * the provider refusing this send's own email (`isSendOwnHalt`), or the account. "Because of
 * this" keeps the claim to this refusal: readers recorded unsent earlier in the send, for
 * their own failures, stay so.
 */
export function refusedMessage(cause: HaltCause | null, error: string | null): string {
  const advice = refusalAdvice(cause);
  if (cause === "not_connected") {
    return `No email provider is connected, so this send is held where it is. ${advice} No one has been marked unsent because of this, and the send goes out at its first retry after a provider is connected.`;
  }
  if (isSendOwnHalt(cause)) {
    return `The provider is refusing this send: ${sentence(error)} ${advice} No one has been marked unsent because of this, and the send tries again on its own, spaced out the longer this lasts.`;
  }
  return `The provider is refusing the account: ${sentence(error)} ${advice} No one has been marked unsent because of this, and the send resumes on its own at its next retry once the account is fixed.`;
}

/**
 * The `provider_unavailable` condition's words (SPEC §12): an outage or a rate limit, which
 * clears on its own, or a rate limit that has outlasted any burst (`isSelfThrottled`), which
 * names the setting that causes it.
 */
export function unavailableMessage(
  send: Pick<Send, "halt_reason" | "halt_cause" | "halt_retries" | "halt_error">,
): string {
  if (isSelfThrottled(send)) {
    return `The provider keeps refusing for its sending rate: ${sentence(send.halt_error)} A burst clears within a second, and this has refused the first request of ${send.halt_retries} retries in a row, minutes apart, so the deployment is asking for more a second than the account allows. Whoever runs the deployment sets SES_MAX_SEND_RATE to the maximum send rate on the SES console’s account dashboard (1 a second in the sandbox), and deploys. The send retries on its own meanwhile, and no one has been marked unsent because of this.`;
  }
  return `The provider is unavailable: ${sentence(send.halt_error)} The send retries on its own, spaced out the longer this lasts, and no one has been marked unsent because of this.`;
}

/** The provider's standing refusal of a send, while one lasts. */
export interface SendHalt {
  reason: HaltReason;
  cause: HaltCause | null;
  error: string;
  /** How many runs in a row this refusal has halted. */
  retries: number;
  /** When refusals for this reason began; null only if the record lacks it. */
  since: number | null;
  /** When the next retry is due. The sweep leaves the send alone until then; null only if the record lacks it. */
  retry_at: number | null;
}

/** The eight denormalized progress counters on a send. */
export interface SendCounts {
  pending: number;
  in_flight: number;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  skipped: number;
  unsent: number;
}

/**
 * A send as stored: its frozen render, its facts, and the counters (the `c_*` columns). The
 * Worker's own row type; the API carries `SendView`, built from it, never this.
 */
export interface Send {
  id: string;
  post_id: string;
  status: SendStatus;
  fire_at: number;
  rendered_html: string;
  rendered_text: string;
  subject: string;
  recipient_count: number;
  locked_until: number | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  /** When the send's first run fixed its audience (SPEC §6); null until it fires. From then on `recipient_count` is the audience at fire. */
  audience_resolved_at: number | null;
  /** When a template or identity change last re-made the frozen render while the send was scheduled; null if never. */
  remade_at: number | null;
  /** When a test of the frozen copy was last sent while the send was scheduled; null if never. */
  tested_at: number | null;
  /**
   * Which address the frozen email carries as "view in browser" (SPEC §5): the post's
   * unlisted link, or, for a send frozen before unlisted links, its archive address, which
   * then answers whatever the post's listing.
   */
  web_link: "unlisted" | "archive";
  /** The render's warnings about the frozen copy (SPEC §5), as a JSON array of strings, kept by the freeze and every re-make; `[]` for a send frozen before they were kept. */
  render_warnings: string;
  /** Why the provider refused this send's last batch as a whole (SPEC §12), or null once a batch is answered: `unavailable` retries on its own, `account` needs the operator. */
  halt_reason: HaltReason | null;
  /** What that refusal is about, for the advice shown with it. */
  halt_cause: HaltCause | null;
  /** The provider's own words for that refusal. */
  halt_error: string | null;
  /** When refusals for this reason began. */
  halted_at: number | null;
  /** How many runs in a row this refusal has halted; 0 while the send is not halted. */
  halt_retries: number;
  /** When the sweep next retries the halted send (SPEC §12); null while it is not halted. */
  halt_retry_at: number | null;
  /** When the provider last answered for any of the send's recipients (SPEC §12); null until it first does, when the send's start stands in. */
  progress_at: number | null;
  c_pending: number;
  c_in_flight: number;
  c_accepted: number;
  c_delivered: number;
  c_bounced: number;
  c_complained: number;
  c_skipped: number;
  c_unsent: number;
  /**
   * Where the send's last visible change sits in one app-wide sequence (SPEC §8): any
   * change a reader could see (a cancel, a move, a re-make, a counter move, a receipt)
   * gives the send a higher `rev` than every change before it, across all sends. A lease
   * renewal alone does not move it.
   */
  rev: number;
}

/** A stored send without the large frozen bodies: what a view is built from. */
export type SendSummary = Omit<
  Send,
  "rendered_html" | "rendered_text" | "web_link" | "render_warnings"
>;

/**
 * How long a send may hand off no one, with nothing else to explain why, before it is
 * flagged as in flight too long (SPEC §12): long enough that a slow tick or a brief stall
 * never alarms, short enough to be told the same afternoon. A send that is handing off is
 * never flagged, however long it takes. The server decides the flag; the editor only
 * words it.
 */
export const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * The minimum lead a deployment runs with when it sets none (SPEC §6): every send spends
 * at least this long visible and cancelable before it fires (I6). The value in force is the
 * deployment's (`DeploymentView.minLeadMs`); this is only its default.
 */
export const DEFAULT_MIN_LEAD_MS = 5 * 60 * 1000;

/**
 * The least minimum lead any deployment may set: one sweep tick. The sweep runs once a
 * minute, so a shorter lead would still be kept, but the tick, not the lead, would decide
 * when a send fires, a precision the system doesn't have (SPEC §6).
 */
export const MIN_LEAD_FLOOR_MS = 60 * 1000;

/**
 * The most minimum lead any deployment may set: one day. The lead bounds only the least
 * wait before a send, never how far out one may be scheduled, so a longer one holds back
 * every Send now and is almost certainly milliseconds typed as seconds (SPEC §6).
 */
export const MIN_LEAD_CEILING_MS = 24 * 60 * 60 * 1000;

/** A minimum lead in words, "5 minutes" or "90 seconds", so the server's refusal and the
 *  editor's copy name it the same way. */
export function formatLead(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

/**
 * Why a requested fire time is refused for being inside the minimum lead (SPEC §6), the one
 * wording for the server's `fire_at_too_soon` and the editor's own check before it asks, on
 * scheduling and rescheduling alike: the lead is what keeps time to cancel.
 */
export function tooSoonMessage(minLeadMs: number): string {
  return `Pick a time at least ${formatLead(minLeadMs)} from now, so there’s time to cancel.`;
}

/** GET /api/sends */
export interface SendListResponse {
  sends: SendView[];
  page: PageMeta;
  /**
   * Where this read stands among the changes to sends, to hand back as `since`: `<seq>.<at>`,
   * the change sequence at the read and the server's time of it, both decimal. Two compare
   * by those numbers (`shared/cursor.ts`).
   */
  cursor: string;
}

/**
 * The live reporting phase, derived from the counters, never stored: waiting in the
 * review window; due (the fire time has passed and the next sweep starts it); handing
 * recipients to the provider (with or without retries); paused between sweep ticks;
 * wedged and awaiting Resolve; dispatched with receipts still arriving; every accepted
 * recipient confirmed; or canceled.
 */
export type SendPhase =
  | "scheduled"
  | "due"
  | "progressing"
  | "retrying"
  | "backing-off"
  | "needs-attention"
  | "settling"
  | "complete"
  | "canceled";

/**
 * One send, as every route carries it (SPEC §8): `GET /api/sends` rows, `GET /api/sends/:id`, the
 * feed, and every action's answer, so a client keeps one shape current from any of them and
 * tells two apart by `rev`. The stored facts, less the frozen bodies (at their own route,
 * `links.email_html` and `links.email_text`), with what the server derives from them at
 * `as_of`: the phase, the conditions, the actions, and the next change.
 */
export interface SendView {
  id: string;
  post_id: string;
  subject: string;
  /** The stored lifecycle state (SPEC §2); `phase` is the finer reading of it. */
  status: SendStatus;
  /**
   * The post's listing (SPEC §5): true when it is email only, mailed as usual but left out
   * of the archive index and the landing page. The post's, not the send's, so every send of
   * a post reads the same, and a change to it is a change to each of them (a new `rev`).
   */
  email_only: boolean;
  /**
   * Which address the send's email carries as "view in browser" (SPEC §5): the post's unlisted
   * link, or, for a send frozen before unlisted links, its archive address, which then answers
   * whatever the listing, since every copy of that email links there.
   */
  web_link: "unlisted" | "archive";
  /** Where the send's last visible change sits in the change sequence: of two views of one send, the higher `rev` is the newer. */
  rev: number;
  /** The server's clock when the view was read: what the clock derives (phase, conditions, actions, `next_change_at`) is as of then. */
  as_of: number;
  fire_at: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  /** When a template or identity change last re-made the scheduled email; null if never. */
  remade_at: number | null;
  /** When the scheduled email was last tested; null if never. */
  tested_at: number | null;
  /**
   * Who the send goes to: `count` is an estimate while the send is scheduled (the audience
   * is resolved when it fires, SPEC §6), and the audience at fire once `fixed`, from
   * `fixed_at` on, never growing.
   */
  audience: { count: number; fixed: boolean; fixed_at: number | null };
  /** Every recipient in exactly one bucket, summing to the audience once it is fixed. */
  counts: SendCounts;
  /** Provider hand-off: how far the send loop has gotten. */
  dispatch: {
    /** Recipients the loop has finished with (accepted, unsent, or skipped). */
    done: number;
    percent: number;
    /** Recipients handed off a minute: what a sweep tick carries, averaged over the ticks run so far (null when not sending, or before the first tick has finished). */
    rate_per_min: number | null;
    /** Rough time to finish dispatch, counted in sweep ticks: to the end of the last tick the rest needs, the wait between ticks included. Only while it is handing off (null otherwise, never while paused, nor before the first tick has finished). */
    eta_ms: number | null;
  };
  /** Delivery confirmation, which lags acceptance. */
  delivery: { confirmed: number; percent_of_accepted: number };
  /** The provider, and its standing refusal of this send while one lasts. */
  provider: { name: string; halt: SendHalt | null };
  phase: SendPhase;
  /** What is wrong with the send, or worth knowing, now (SPEC §8, §12), each with its own words and the action that settles it, if any. */
  conditions: SendCondition[];
  /** What the server would accept on the send right now. */
  actions: SendAction[];
  /**
   * The earliest moment the send can change with no one acting on it, by the server's
   * clock: at or before `as_of` while it can move at any moment (due, or sending with work
   * in hand), a later time while it waits on the clock or the sweep (its fire time, a halt's
   * next retry, the in-flight-too-long threshold), or null when only an action or a receipt
   * can change it (wedged, missed, finished).
   */
  next_change_at: number | null;
  /**
   * Where the send's other resources are. `archive` is the post's archive address, absolute,
   * while it answers: once the send has started, while the post is listed (or whatever the
   * listing, for a send whose email carries that address); null otherwise. `unlisted` is the
   * post's unlisted link, absolute, which every email of it carries (SPEC §5); it opens the
   * page once the send has started, forwarding to `archive` while the post is listed.
   */
  links: {
    self: string;
    email_html: string;
    email_text: string;
    deliveries: string;
    deliveries_csv: string;
    post: string;
    archive: string | null;
    unlisted: string | null;
  };
}

/** Something a person can do to a send through the API, exactly as the server would take it now. */
export interface SendAction {
  name: "cancel" | "reschedule" | "resolve";
  method: "POST";
  /** The route, with the send's id filled in. */
  path: string;
}

/** What a condition asks of a person: `action` needs one (red), `warn` is worth a look (amber), `info` is worth knowing. */
export type ConditionSeverity = "action" | "warn" | "info";

/** What every condition carries. */
interface ConditionBase {
  severity: ConditionSeverity;
  /** When the condition began, or null when the record does not say. */
  since: number | null;
  /** The server's words for it, whole sentences, the same wherever it is shown. */
  message: string;
  /** The action that settles it, if a person can take one through the API. */
  action: SendAction | null;
}

/**
 * One open condition on a send (SPEC §8, §12), derived by the server from the record, the
 * same on every route:
 *
 * - `missed`: still scheduled past the missed tolerance; the sweep that fires it has not run.
 * - `stuck`: still sending, with no recipient handed off for the stuck threshold and no
 *   halt or wedge to explain it: the sweep has stopped, or every run fails.
 * - `wedged`: recipients whose delivery is unknown; `count` of them, settled by Resolve.
 * - `refused`: the provider refuses the account, or this send's own email (`isSendOwnHalt`);
 *   its `cause`, `error`, the `advice` for the fix (outside the app), and `retry_at`. No
 *   action: the send resumes on its own.
 * - `provider_unavailable`: the provider is down or rate-limiting; retried at `retry_at`.
 * - `bounce_spike`: a recently sent send's confirmed bounces reached the danger zone.
 * - `no_receipts`: a recently sent send has heard no receipt for any recipient the provider
 *   took, long after its dispatch finished: the provider's events may not be reaching the
 *   app; `accepted` is how many wait on one.
 * - `remade`: a template or identity change re-made the scheduled email after its last test.
 * - `untested`: no test of the scheduled email has been sent, and it was never re-made.
 * - `daily_writes`: on Workers Free's limits, a scheduled send to more recipients than D1's
 *   daily writes comfortably cover, after what imports already wrote on the UTC day it
 *   fires; `recipients` is its audience as scheduled.
 */
export type SendCondition =
  | (ConditionBase & { kind: "missed" })
  | (ConditionBase & { kind: "stuck" })
  | (ConditionBase & { kind: "wedged"; count: number })
  | (ConditionBase & {
      kind: "refused";
      cause: HaltCause | null;
      error: string;
      advice: string;
      retry_at: number | null;
    })
  | (ConditionBase & { kind: "provider_unavailable"; error: string; retry_at: number | null })
  | (ConditionBase & { kind: "bounce_spike"; bounced: number; rate: number })
  | (ConditionBase & { kind: "no_receipts"; accepted: number })
  | (ConditionBase & { kind: "remade"; tested_at: number | null })
  | (ConditionBase & { kind: "untested" })
  | (ConditionBase & { kind: "daily_writes"; recipients: number });

/** The kinds of condition. */
export type ConditionKind = SendCondition["kind"];

/** A condition in the feed's roll-up: which send it is on, and the condition. */
export type FeedCondition = SendCondition & { send_id: string; subject: string };

/**
 * The bounce spike (SPEC §8): a send's confirmed bounces over its audience at fire reaching
 * the provider's danger zone. SES puts a sender under review at a 5% bounce rate; the small
 * absolute floor keeps a tiny audience's noisy rate (one bad address among a handful) from
 * tripping it; and only a send finished within the recent window is read, since an old
 * send's bounces are history, not a risk to act on. Well above the dev simulation's ~2%.
 */
export const BOUNCE_SPIKE_RATE = 0.05;
export const BOUNCE_SPIKE_MIN = 3;
export const BOUNCE_SPIKE_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * No receipts (SPEC §8): a send that finished dispatch this long ago with not one receipt
 * for anyone the provider took. A provider reports a delivery within seconds to minutes, so
 * an hour of silence over a whole send is not settling but receipts that are not arriving.
 * Read over the same recent window as the bounce spike, since a long-past send's silence
 * is history the publisher can no longer act on.
 */
export const NO_RECEIPTS_AFTER_MS = 60 * 60 * 1000;

/**
 * On the Workers Free plan's limits, a scheduled send to more than this many recipients may
 * spend D1's daily allowance of written rows on its own, which stops the instance until
 * midnight UTC; fewer do when imports already wrote on the day it fires. Past it, Workers
 * Paid is recommended. The warning never refuses: the account may be on Paid while the
 * Worker is configured for Free.
 */
export const DAILY_WRITES_SEND_RECIPIENTS = Math.floor(
  DAILY_WRITES_BUDGET / SEND_WRITES_PER_RECIPIENT,
);

/**
 * Whether a send to `recipients`, firing at `fireAt`, may spend D1's daily writes, given the
 * day so far: what imports wrote counts when the send fires before the day ends.
 */
export function sendSpendsDailyWrites(recipients: number, fireAt: number, day: WritesDay): boolean {
  return (
    recipients * SEND_WRITES_PER_RECIPIENT + importWritesBefore(fireAt, day) > DAILY_WRITES_BUDGET
  );
}

/**
 * Whether what the day's imports wrote can change the send's `daily_writes` condition: it is
 * scheduled to fire before the day ends, and fits the budget on its own. Any other send's
 * condition is the same whatever they wrote, so a route reads them only for such a send.
 */
export function importsWeighOn(
  send: Pick<SendSummary, "status" | "fire_at" | "recipient_count">,
  until: number,
): boolean {
  return (
    send.status === "scheduled" &&
    send.fire_at < until &&
    send.recipient_count * SEND_WRITES_PER_RECIPIENT <= DAILY_WRITES_BUDGET
  );
}

function importWritesBefore(fireAt: number, day: WritesDay): number {
  return fireAt < day.until ? day.importWrites : 0;
}

/**
 * The `daily_writes` condition's words, for a send to `recipients`. `afterImports`: the
 * send fires on a UTC day imports already wrote on, and that is part of why it may not fit.
 */
export function dailyWritesSendWarning(recipients: number, afterImports = false): string {
  const n = recipients.toLocaleString("en-US");
  return afterImports
    ? `On the Workers Free plan’s limits, a send to ${n} recipients on the same day as today’s imports may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Send it tomorrow (UTC), or move to Workers Paid, which is recommended for a list of more than ${DAILY_WRITES_SEND_RECIPIENTS.toLocaleString("en-US")}.`
    : `On the Workers Free plan’s limits, a send to ${n} recipients may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Workers Paid is recommended for a list of more than ${DAILY_WRITES_SEND_RECIPIENTS.toLocaleString("en-US")}.`;
}

/** The `daily_writes` condition's words for a send that may not fit, saying whether the day's imports are part of why. */
export function dailyWritesSendMessage(recipients: number, fireAt: number, day: WritesDay): string {
  const alone = recipients * SEND_WRITES_PER_RECIPIENT > DAILY_WRITES_BUDGET;
  return dailyWritesSendWarning(recipients, !alone && importWritesBefore(fireAt, day) > 0);
}

/** GET /api/sends/feed: what a client follows to keep up with sends without polling each one. */
export interface SendFeedResponse {
  /** The server's clock at the read, so a client times its next read by the server's clock, not its own. */
  now: number;
  /**
   * With `since`, every send that changed after that cursor, whatever its state, those the
   * clock changed with no write included (turned due, missed, in flight too long, or wedged
   * as a lease ran out); without it, every send that can change on its own. Soonest fire first.
   */
  sends: SendView[];
  /** With `since`, every send removed after that cursor (deleted with its post), in sequence order; empty without it. */
  removed: RemovedSend[];
  /** Where this read stands (`<seq>.<at>`, as on `GET /api/sends`), to hand back as `since` on the next. */
  cursor: string;
  /** Whether the read stopped at `limit` changes with more after `cursor`: read again at once from it. */
  more: boolean;
  /** Every open condition across the sends that can have one (scheduled, sending, and recently sent), whether or not they changed: every open problem in one read, most severe first. */
  conditions: FeedCondition[];
  /**
   * When to read again, by the server's clock: soon while a send can move, about once a
   * minute while none can, and never later than just past the next change the clock or the
   * sweep will make. Advisory: reading sooner (right after acting) is always fine.
   */
  read_again_at: number;
}

/** A send removed since a cursor: which, and where the removal sits in the change sequence. */
export interface RemovedSend {
  id: string;
  rev: number;
}

/** The sent record's per-recipient delivery breakdown (SPEC §8). */
export interface DeliveryOutcomes {
  recipients: number;
  delivered: number;
  bounced: number;
  complained: number;
  /** Never accepted by the provider (transport-level; does not itself suppress). */
  unsent: number;
  /** Excluded at send time (unsubscribed or suppressed after the audience froze). */
  skipped: number;
  /** Accepted by the provider, with no delivery event yet (a provider may emit none). */
  accepted: number;
  in_flight: number;
}

/** GET /api/sends/:id: the send, and its record's outcome breakdown. */
export interface SendResponse {
  send: SendView;
  outcomes: DeliveryOutcomes;
  /** Where this read stands among the changes to sends (`<seq>.<at>`), to follow the send from with `GET /api/sends/feed`. */
  cursor: string;
}

/** The buckets GET /api/sends/:id/deliveries filters by, exactly as the outcomes count them, plus "all" and "failures" (bounced, complained, or unsent). */
export type DeliveryView =
  | "all"
  | "failures"
  | "delivered"
  | "bounced"
  | "complained"
  | "unsent"
  | "skipped"
  | "accepted"
  | "in_flight";

/**
 * One recipient's row for the in-app record: the send-loop status and the later webhook
 * event, the provider detail or error, and for a bounce the frozen hard/soft kind (null
 * when the kind is unknown; rendered as a plain "Bounce").
 */
export interface DeliveryRecord {
  email: string;
  status: string;
  event: string | null;
  event_detail: string | null;
  event_at: number | null;
  error: string | null;
  attempts: number;
  bounce_kind: string | null;
}

/** GET /api/sends/:id/deliveries */
export interface DeliveryListResponse {
  deliveries: DeliveryRecord[];
  view: DeliveryView;
  page: PageMeta;
}

/** The publisher's answer for a wedged send's ambiguous recipients (SPEC §12). */
export type StuckResolution = "unsent" | "accepted";

/** POST /api/sends/:id/resolve */
export interface ResolveResponse {
  send: SendView;
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  /** How many ambiguous recipients this action adjudicated. */
  resolved: number;
  /** Whether the send reached its completion gate and finished. */
  completed: boolean;
}

/** POST /api/sends/:id/cancel and /reschedule */
export interface SendActionResponse {
  send: SendView;
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  /** False when the send already stood as asked (canceled already, or already at that time): nothing was written. */
  changed: boolean;
}

/**
 * POST /api/posts/:id/schedule and /send: the send that was frozen (SPEC §6). A second
 * send-now for a post already in its window answers with that send and `idempotent`.
 */
export interface ScheduleResponse {
  send: SendView;
  /** What the render said about the frozen copy (SPEC §5), such as an image the post never uploaded; empty when it said nothing. */
  warnings: string[];
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  idempotent?: boolean;
}
