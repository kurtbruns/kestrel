// Subscribers as the API carries them (SPEC §7): the row, the suppression annotation the
// list adds, and the bodies of the subscriber routes. The Worker's routes produce these
// shapes and the editor consumes them; one definition, so neither can drift.

import type { PageMeta } from "./list";

export type SubscriberStatus = "pending" | "confirmed" | "unsubscribed";

export interface Subscriber {
  id: string;
  email: string;
  status: SubscriberStatus;
  /** One-shot double opt-in token, rotated on each re-arm; null once spent. */
  confirm_token: string | null;
  /** When the last confirmation email went out; null if none has. */
  confirm_sent_at: number | null;
  /** Durable per-subscriber token in every delivered mail's unsubscribe link; never rotated (I2). */
  unsub_token: string;
  created_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
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

/** GET /subscribers */
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

/** POST /subscribers. `subscriber` is null when the address has no row: a suppressed
 *  address that was never on the list. */
export interface SubscribeResponse {
  subscriber: Subscriber | null;
  action: SubscribeAction;
}

/**
 * POST /subscribe, the public form, as JSON. One answer whatever the address's state, so
 * the reply never says who is on the list (SPEC §7). Only a confirmation the provider
 * would not take is answered differently, as an error.
 */
export interface PublicSubscribeResponse {
  status: "check_inbox";
}

/** GET /subscribers/:id */
export interface SubscriberResponse {
  subscriber: Subscriber;
  suppressed: boolean;
}
