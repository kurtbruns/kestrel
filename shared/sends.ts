// Sends as the API carries them (SPEC §6, §8, §12): one `SendView` of a send, the same on
// every route (the list, the send, the feed, and every action's answer), the feed the pages
// follow, and the per-recipient record; beside them, the stored send row the Worker builds
// the view from, which never goes on the wire as it is.
// The Worker's routes produce these shapes and the editor consumes them; one definition,
// so neither can drift.

import type { PageMeta } from "./list";

export type SendStatus = "scheduled" | "sending" | "sent" | "canceled";

/**
 * Why a provider refused a whole batch (SPEC §12): it is `unavailable` (an outage or a
 * rate limit, which clears on its own), or it refuses the `account` (a bad key, an
 * unverified domain, a paused account), which needs the operator.
 */
export type HaltReason = "unavailable" | "account";

/**
 * What a refusal is about, so the advice can name the fix: the API key or credentials,
 * the sender (an unverified domain or from-address), a spent sending quota, the account
 * paused or suspended by the provider, a rate limit, or the provider itself failing.
 */
export type HaltCause = "credentials" | "sender" | "quota" | "suspended" | "rate_limit" | "outage";

/**
 * What to do about the provider refusing the account, by what the refusal is about
 * (SPEC §12). The fix is always outside the app: nothing in it can change a credential or
 * the provider's view of the account (SPEC §9). One wording for the watch and the notification
 * that tells the publisher, so the two never advise differently.
 */
export function refusalAdvice(cause: HaltCause | null): string {
  switch (cause) {
    case "credentials":
      return "Replace the provider's API key or credentials in the deployment's secrets.";
    case "sender":
      return "Verify the sending domain or from-address with the provider.";
    case "quota":
      return "Wait for the provider's sending quota to reset, or raise it on your plan.";
    case "suspended":
      return "Settle the account's standing with the provider (for SES, in the SES console).";
    default:
      return "Fix the account with the provider.";
  }
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
export type SendSummary = Omit<Send, "rendered_html" | "rendered_text">;

/**
 * How long a send may stay `sending` before it is flagged as in flight too long (SPEC
 * §12): long enough that an ordinary outage's retries never alarm, short enough to be
 * told the same afternoon. The server decides the flag; the editor only words it.
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

/** GET /sends */
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
 * One send, as every route carries it (SPEC §8): `GET /sends` rows, `GET /sends/:id`, the
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
  /** Where the send's other resources are. `archive` is the published post, absolute, once the send is sent; null before. */
  links: {
    self: string;
    email_html: string;
    email_text: string;
    deliveries: string;
    deliveries_csv: string;
    post: string;
    archive: string | null;
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
 * - `stuck`: still sending past the stuck threshold after it started.
 * - `wedged`: recipients whose delivery is unknown; `count` of them, settled by Resolve.
 * - `refused`: the provider refuses the account; its `cause`, `error`, the `advice` for the
 *   fix (outside the app), and `retry_at`. No action: the send resumes on its own.
 * - `provider_unavailable`: the provider is down or rate-limiting; retried at `retry_at`.
 * - `bounce_spike`: a recently sent send's confirmed bounces reached the danger zone.
 * - `remade`: a template or identity change re-made the scheduled email after its last test.
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
  | (ConditionBase & { kind: "remade"; tested_at: number | null });

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

/** GET /sends/feed: what a client follows to keep up with sends without polling each one. */
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
  /** Where this read stands (`<seq>.<at>`, as on `GET /sends`), to hand back as `since` on the next. */
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

/** GET /sends/:id: the send, and its record's outcome breakdown. */
export interface SendResponse {
  send: SendView;
  outcomes: DeliveryOutcomes;
  /** Where this read stands among the changes to sends (`<seq>.<at>`), to follow the send from with `GET /sends/feed`. */
  cursor: string;
}

/** The buckets GET /sends/:id/deliveries filters by, exactly as the outcomes count them, plus "all" and "failures" (bounced, complained, or unsent). */
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

/** GET /sends/:id/deliveries */
export interface DeliveryListResponse {
  deliveries: DeliveryRecord[];
  view: DeliveryView;
  page: PageMeta;
}

/** The publisher's answer for a wedged send's ambiguous recipients (SPEC §12). */
export type StuckResolution = "unsent" | "accepted";

/** POST /sends/:id/resolve */
export interface ResolveResponse {
  send: SendView;
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  /** How many ambiguous recipients this action adjudicated. */
  resolved: number;
  /** Whether the send reached its completion gate and finished. */
  completed: boolean;
}

/** POST /sends/:id/cancel and /reschedule */
export interface SendActionResponse {
  send: SendView;
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  /** False when the send already stood as asked (canceled already, or already at that time): nothing was written. */
  changed: boolean;
}

/**
 * POST /posts/:id/schedule and /send: the send that was frozen (SPEC §6). A second
 * send-now for a post already in its window answers with that send and `idempotent`.
 */
export interface ScheduleResponse {
  send: SendView;
  /** Where the answer stands among the changes to sends, to follow the send from. */
  cursor: string;
  idempotent?: boolean;
}
