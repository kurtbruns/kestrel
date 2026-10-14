// Subscribers as the API carries them (SPEC §7): the row, the suppression annotation the
// list adds, and the bodies of the subscriber routes. The Worker's routes produce these
// shapes and the editor consumes them; one definition, so neither can drift.

import type { OptIn } from "./imports";
import type { PageMeta } from "./list";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

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
  suppression_reason: string | null;
  suppression_detail: string | null;
}

export interface SubscriberCounts {
  pending: number;
  confirmed: number;
  unsubscribed: number;
  suppressed: number;
}

/** GET /api/subscribers */
export interface SubscriberListResponse {
  counts: SubscriberCounts;
  subscribers: SubscriberListItem[];
  page: PageMeta;
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
  erased: { email: string; deliveries: number; suppression: string };
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
