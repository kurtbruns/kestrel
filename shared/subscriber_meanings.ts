// What each subscriber label and action means, in the words the publisher reads (SPEC §7).
// The editor's legend and the API reference both print these, so a person in the editor
// and a client reading the reference are told the same thing, and neither can drift.

import type { SubscriberStatus, SuppressionReason } from "./subscribers";

/** What each consent state means. */
export const STATUS_MEANING: Record<SubscriberStatus, string> = {
  pending: "Subscribed but hasn’t clicked the confirmation email.",
  confirmed:
    "Agreed to receive your posts, here or at the service they were imported from, and receives them.",
  unsubscribed: "Opted out, themselves or by asking you.",
};

/** What being suppressed means, whatever the reason. */
export const SUPPRESSED_MEANING =
  "The address isn’t mailed, whatever its status, which stays as it was.";

/** The flag a suppression shows as. An import's bounce or complaint reads as one seen here. */
export type SuppressionFlag = "bounced" | "complaint" | "blocked" | "erased";

export const SUPPRESSION_FLAG: Record<SuppressionReason, SuppressionFlag> = {
  bounce: "bounced",
  import_bounce: "bounced",
  complaint: "complaint",
  import_complaint: "complaint",
  manual: "blocked",
  erased: "erased",
};

/** What each flag means, and so whose decision the suppression was. */
export const FLAG_MEANING: Record<SuppressionFlag, string> = {
  bounced: "Mail to the address failed, here or at the service it was imported from.",
  complaint: "Marked as spam, here or at the service it was imported from.",
  blocked: "You chose to stop mailing it. You can unblock it.",
  erased:
    "A do-not-contact marker kept after an erasure. Only the person’s own confirmation lifts it.",
};

/** An act on a subscriber: its name in the editor's row menu, and when it is the one to use. */
export interface SubscriberAction {
  label: string;
  when: string;
}

/**
 * The acts on a subscriber, each recording whose decision it was: an unsubscribe and an
 * erasure are the person's, made on their request; a block is the publisher's own.
 */
export const SUBSCRIBER_ACTIONS = {
  unsubscribe: {
    label: "Unsubscribe",
    when: "When they ask you to take them off the list. They can rejoin by subscribing again.",
  },
  block: {
    label: "Block",
    when: "When you decide yourself to stop mailing an address. Their status stays as it was, and you can unblock it.",
  },
  erase: {
    label: "Erase",
    when: "When they ask you to delete their data. It can’t be undone.",
  },
} satisfies Record<string, SubscriberAction>;
