// Subscribers as the API carries them (SPEC §7): the row, the suppression annotation the
// list adds, and the bodies of the subscriber and suppression routes. The Worker's routes produce these
// shapes and the editor consumes them; one definition, so neither can drift.

import type { OptIn } from "./imports";
import type { PageMeta } from "./list";

/** A subscriber's consent state (SPEC §7); `subscriber_meanings.ts` says what each means. */
export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

/**
 * Why an address is suppressed (SPEC §7), which also says whose decision it was: the
 * provider's (`bounce`, `complaint`), the previous service's, brought by an import
 * (`import_bounce`, `import_complaint`), a block by hand (`manual`), the publisher's own or
 * one an import brought from the previous service, or an
 * erasure's do-not-contact marker (`erased`). `subscriber_meanings.ts` says what each means.
 */
export type SuppressionReason =
  | "bounce"
  | "complaint"
  | "manual"
  | "erased"
  | "import_bounce"
  | "import_complaint";

/** One suppressed address: why, the provider's or the publisher's words if any, and since when. */
export interface Suppression {
  email: string;
  reason: SuppressionReason;
  detail: string | null;
  created_at: number;
}

export interface Subscriber {
  id: string;
  email: string;
  status: SubscriberStatus;
  /** One-shot double opt-in token, rotated on each re-arm; null once spent. */
  confirm_token: string | null;
  /** When the confirmation carrying `confirm_token` went out; null if none has. */
  confirm_sent_at: number | null;
  /** When a confirmation was last attempted, the per-address cooldown's clock. */
  confirm_attempt_at: number | null;
  /** Durable per-subscriber token in every delivered mail's unsubscribe link; never rotated (I2). */
  unsub_token: string;
  created_at: number;
  confirmed_at: number | null;
  /** When they last left; kept while they are pending again, so a row that left still reads so until its owner confirms. */
  unsubscribed_at: number | null;
  /** Where consent was collected (SPEC §7): `kestrel` for this app's own double opt-in, or the source an import claimed. */
  origin: string;
  /** How consent was collected: this app's is `double`; an import's is what its file claimed. */
  opt_in: OptIn;
  /** The proof of consent, as JSON text: an import's evidence verbatim, or the IP a confirmation here came from. */
  consent_evidence: string | null;
  /** The import that confirmed or added this subscriber, or null when they joined here. What makes a subscriber read as imported. */
  import_id: string | null;
}

/** The list row: the subscriber plus why it is suppressed, if it is, so the list can say so without a lookup. */
export interface SubscriberListItem extends Subscriber {
  suppressed: boolean;
  suppression_reason: SuppressionReason | null;
  suppression_detail: string | null;
}

/** The list's composition: subscribers by consent state, and how many of them are suppressed. */
export interface SubscriberCounts {
  pending: number;
  confirmed: number;
  unsubscribed: number;
  /** Subscribers whose address is suppressed, whatever their status, so it overlaps the three others. Addresses suppressed with no subscriber are in `GET /api/suppressions`. */
  suppressed: number;
}

/** GET /api/subscribers */
export interface SubscriberListResponse {
  counts: SubscriberCounts;
  subscribers: SubscriberListItem[];
  page: PageMeta;
  /** On the Workers Free plan's limits, once the confirmed list is past what Free suits (`FREE_PLAN_LIST`): the server's advice to move to Workers Paid, to show as it stands. Null otherwise. */
  workers_plan_advice: string | null;
}

/**
 * What adding an address did (SPEC §7). The first three sent a confirmation. The rest sent
 * none: double opt-in never re-confirms a confirmed address, a suppressed one is never
 * mailed, and an address sent a confirmation a moment ago waits out the cooldown.
 */
export type SubscribeAction =
  | "created"
  | "resubscribed"
  | "pending_resent"
  | "already_confirmed"
  | "suppressed"
  | "recently_sent";

/** POST /api/subscribers. `subscriber` is null when the address has no row: a suppressed
 *  address that was never on the list. */
export interface SubscribeResponse {
  subscriber: Subscriber | null;
  action: SubscribeAction;
}

/**
 * POST /subscribe, the public form, as JSON. One answer whatever the address's state, given
 * before any confirmation is sent, so neither the reply nor its timing says who is on the
 * list (SPEC §7).
 */
export interface PublicSubscribeResponse {
  status: "check_inbox";
}

/** GET /api/subscribers/:id */
export interface SubscriberResponse {
  subscriber: Subscriber;
  suppressed: boolean;
}

/** What an erasure puts in place of the address on a person's past delivery rows (SPEC §7),
 *  followed by random hex shared by that person's rows. */
export const ERASED_PREFIX = "erased:";

/** Whether a delivery row's address is an erasure's placeholder rather than an address. */
export function isErasedPlaceholder(email: string): boolean {
  return email.startsWith(ERASED_PREFIX);
}

/**
 * POST /api/subscribers/:id/erase (SPEC §7). The subscriber is gone, so the answer is what
 * was done: the address, which the list now keeps only as a do-not-contact suppression;
 * how many past delivery rows show an erased recipient in its place; and the suppression
 * it is left with, `erased` or a bounce or complaint it already had, which stands.
 */
export interface EraseResponse {
  erased: { email: string; deliveries: number; suppression: SuppressionReason };
}

/**
 * POST /api/subscribers refused because the address was erased (SPEC §7): a 409
 * `erasure_acknowledgement_required`, with when it was erased. Sending again with
 * `acknowledge_erasure: true` sends the confirmation; the public form never asks.
 */
export interface ErasureAcknowledgementRequired {
  error: "erasure_acknowledgement_required";
  message: string;
  erased_at: number;
}

/** GET /api/suppressions: every suppressed address, newest first. */
export interface SuppressionListResponse {
  suppressions: Suppression[];
}

/**
 * POST /api/suppressions, the publisher's block (SPEC §7). An address already suppressed
 * keeps the suppression it has, which says more about it than a block would, so `added`
 * is false and `suppression` is the one that stands.
 */
export interface BlockResponse {
  suppression: Suppression;
  added: boolean;
}

/** DELETE /api/suppressions/:email: whether a suppression was there to clear. */
export interface ClearSuppressionResponse {
  email: string;
  cleared: boolean;
}
