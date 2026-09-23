// Sends as the API carries them (SPEC §6, §8, §12): the send row and its counters, the
// list summary, the live progress shape the watch polls, and the per-recipient record.
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

/** The provider's standing refusal of a send, as the watch reports it. */
export interface SendHalt {
  reason: HaltReason;
  cause: HaltCause | null;
  error: string;
  since: number;
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

/** A send, with its frozen render and the counters (the `c_*` columns) the progress view reads. */
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
  /** When a template or identity change last re-made the frozen render while the send was scheduled; null if never. */
  remade_at: number | null;
  /** Why the provider refused this send's last batch as a whole (SPEC §12), or null once a batch is answered: `unavailable` retries on its own, `account` needs the operator. */
  halt_reason: HaltReason | null;
  /** What that refusal is about, for the advice shown with it. */
  halt_cause: HaltCause | null;
  /** The provider's own words for that refusal. */
  halt_error: string | null;
  /** When refusals for this reason began. */
  halted_at: number | null;
  c_pending: number;
  c_in_flight: number;
  c_accepted: number;
  c_delivered: number;
  c_bounced: number;
  c_complained: number;
  c_skipped: number;
  c_unsent: number;
}

/** The list view's send: everything but the large frozen bodies. */
export type SendSummary = Omit<Send, "rendered_html" | "rendered_text">;

/** GET /sends */
export interface SendListResponse {
  sends: SendSummary[];
  page: PageMeta;
}

/**
 * The live reporting phase, derived from the counters, never stored: waiting in the
 * review window; handing recipients to the provider (with or without retries); paused
 * between sweep ticks; wedged and awaiting Resolve; dispatched with receipts still
 * arriving; every accepted recipient confirmed; or canceled.
 */
export type SendPhase =
  | "scheduled"
  | "progressing"
  | "retrying"
  | "backing-off"
  | "needs-attention"
  | "settling"
  | "complete"
  | "canceled";

/** GET /sends/:id/progress: the single-row poll the watch view and the dashboard widget read. */
export interface SendProgress {
  state: SendStatus;
  phase: SendPhase;
  /** The frozen audience size, or the schedule-time estimate before any recipient rows exist. */
  total: number;
  counts: SendCounts;
  /** Provider hand-off: how far the send loop has gotten. */
  dispatch: {
    /** Recipients the loop has finished with (accepted, unsent, or skipped). */
    done: number;
    percent: number;
    /** Recipients accepted per minute since the send started (null when not sending). */
    rate_per_min: number | null;
    /** Rough time to finish dispatch from the average rate (null when not computable). */
    eta_ms: number | null;
  };
  /** Delivery confirmation, which lags acceptance. */
  delivery: {
    confirmed: number;
    percent_of_accepted: number;
  };
  /** The provider, and its standing refusal of this send while one lasts. */
  provider: { name: string; halt: SendHalt | null };
  /** The loud conditions (SPEC §12) the watch surfaces; Resolve appears when `wedged`, and `refused` is the provider refusing the account, carrying its words in `provider.halt`. */
  attention: {
    wedged: boolean;
    wedged_count: number;
    stuck: boolean;
    missed: boolean;
    refused: boolean;
  };
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

/** GET /sends/:id: the send, where it stands, its record, and its archive link once sent. */
export interface SendResponse {
  send: Send;
  progress: SendProgress;
  outcomes: DeliveryOutcomes;
  slug: string | null;
  archive_url: string | null;
  published: boolean;
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
  view: DeliveryView | null;
  page: PageMeta;
}

/** The publisher's answer for a wedged send's ambiguous recipients (SPEC §12). */
export type StuckResolution = "unsent" | "accepted";

/** POST /sends/:id/resolve */
export interface ResolveResponse {
  send: Send;
  /** How many ambiguous recipients this action adjudicated. */
  resolved: number;
  /** Whether the send reached its completion gate and finished. */
  completed: boolean;
}

/** POST /sends/:id/cancel and /reschedule */
export interface SendActionResponse {
  send: Send;
}

/**
 * POST /posts/:id/schedule and /send: the send that was frozen (SPEC §6). A second
 * send-now for a post already in its window answers with that send and `idempotent`.
 */
export interface ScheduleResponse {
  send: Send;
  idempotent?: boolean;
}
