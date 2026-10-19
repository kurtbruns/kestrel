// Subscribers as the API carries them (SPEC §7): the one shape every route answers, its
// suppression included, and the bodies of the subscriber and suppression routes. The Worker's routes produce these
// shapes and the editor consumes them; one definition, so neither can drift.

import type { OptIn } from "./imports";
import type { PageMeta } from "./list";
import type { DeliveryRecord, SendView } from "./sends";

/** A subscriber's consent states (SPEC §7); `subscriber_meanings.ts` says what each means. */
export const SUBSCRIBER_STATUSES = ["pending", "confirmed", "unsubscribed"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

/**
 * Why a subscriber left (SPEC §7), kept while they have left and not confirmed since: their own
 * unsubscribe link or one-click header (`reader`), the publisher on their request
 * (`publisher`), a complaint about the mail (`complaint`), an erasure (`erased`), or a list
 * brought from elsewhere that says they left and not why (`import`).
 * `subscriber_meanings.ts` says what each means.
 */
export const UNSUBSCRIBE_CAUSES = ["reader", "publisher", "complaint", "erased", "import"] as const;
export type UnsubscribeCause = (typeof UNSUBSCRIBE_CAUSES)[number];

// The causes that carry a rule of their own: an erasure's record is stripped, and a complaint
// or an erasure keeps the publisher from adding the person back. The rest rank alike.
const CAUSE_STRENGTH: Record<UnsubscribeCause, number> = {
  reader: 0,
  publisher: 0,
  import: 0,
  complaint: 1,
  erased: 2,
};

/**
 * The cause that stands when someone who already left leaves again (SPEC §7): the stronger of
 * the two, an erasure over a complaint over the rest, and among the rest the one already held.
 */
export function strongerCause(held: UnsubscribeCause, next: UnsubscribeCause): UnsubscribeCause {
  return CAUSE_STRENGTH[next] > CAUSE_STRENGTH[held] ? next : held;
}

/** The causes after which only the person's own sign-up brings them back: the publisher's Add
 *  is refused (SPEC §7). */
export const SIGNUP_ONLY_CAUSES: readonly UnsubscribeCause[] = ["complaint", "erased"];

/**
 * Why an address is suppressed (SPEC §7), always the sender's side, and whose decision it
 * was: the provider's (`bounce`), the previous service's bounce, brought by an import
 * (`import_bounce`), or a block (`manual`), the publisher's own or one an import brought.
 * The publisher lifts each. `subscriber_meanings.ts` says what each means.
 */
export const SUPPRESSION_REASONS = ["bounce", "manual", "import_bounce"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** One suppressed address: why, the provider's or the publisher's words if any, and since when. */
export interface Suppression {
  email: string;
  reason: SuppressionReason;
  detail: string | null;
  created_at: number;
}

/** Why a subscriber's address is suppressed, as a subscriber carries it. */
export interface SubscriberSuppression {
  reason: SuppressionReason;
  /** The provider's or the publisher's words, if any. */
  detail: string | null;
  /** Since when the address has been suppressed. */
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
  /** Durable per-subscriber token in every delivered mail's unsubscribe link; never rotated (I2). Null once erased, which discards it; a person who signs up again gets a new one. */
  unsub_token: string | null;
  created_at: number;
  confirmed_at: number | null;
  /** When they last left; kept while they are pending again, so a row that left still reads so until its owner confirms. */
  unsubscribed_at: number | null;
  /** Why they left, while they have left and not confirmed since: on every unsubscribed subscriber, and on a pending one who left and signed up again. Null otherwise. */
  unsubscribe_cause: UnsubscribeCause | null;
  /** Where consent was collected (SPEC §7): `kestrel` for this app's own double opt-in, or the source an import claimed; null once erased. */
  origin: string | null;
  /** How consent was collected: this app's is `double`; an import's is what its file claimed; null once erased. */
  opt_in: OptIn | null;
  /** The proof of consent, as JSON text: an import's evidence verbatim, or the IP a confirmation here came from. */
  consent_evidence: string | null;
  /** The import that confirmed or added this subscriber, or null when they joined here. What makes a subscriber read as imported. */
  import_id: string | null;
  /** Whether the address is suppressed, and why; null when it is mailed as its status says. */
  suppression: SubscriberSuppression | null;
  /** Whether a send firing now would include them (SPEC §7): confirmed, and not suppressed. */
  receives_posts: boolean;
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
  subscribers: Subscriber[];
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

/** GET /api/subscribers/:id, and an unsubscribe by id */
export interface SubscriberResponse {
  subscriber: Subscriber;
}

/** One send a subscriber's address was in: the send as its view, and the address's row in its record. */
export interface SubscriberDelivery {
  send: SendView;
  delivery: DeliveryRecord;
}

/**
 * GET /api/subscribers/:id/deliveries: the sends the subscriber's address was in, newest
 * fire time first, a page at a time. `next` is the cursor for the page after, null on the last.
 */
export interface SubscriberDeliveriesResponse {
  deliveries: SubscriberDelivery[];
  next: string | null;
}

/** What an erasure puts in place of the address on a person's past delivery rows (SPEC §7),
 *  followed by random hex shared by that person's rows. */
export const ERASED_PREFIX = "erased:";

/** Whether a delivery row's address is an erasure's placeholder rather than an address. */
export function isErasedPlaceholder(email: string): boolean {
  return email.startsWith(ERASED_PREFIX);
}

/**
 * POST /api/subscribers/:id/erase (SPEC §7): the subscriber as the erasure left them,
 * unsubscribed by it and holding only the address and when, and how many past delivery rows
 * this erasure put a placeholder in place of the address on (0 for a repeat, which changes
 * nothing).
 */
export interface EraseResponse {
  subscriber: Subscriber;
  deliveries: number;
}

/** GET /api/suppressions: one page of suppressed addresses, newest first unless sorted. */
export interface SuppressionListResponse {
  suppressions: Suppression[];
  page: PageMeta;
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

/** POST /api/suppressions/lift: whether the named suppression was there to lift. */
export interface LiftSuppressionResponse {
  email: string;
  lifted: boolean;
}
