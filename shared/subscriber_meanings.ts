// What each subscriber label and action means, in the words the publisher reads (SPEC §7).
// The editor's legend and the API reference both print these, so a person in the editor
// and a client reading the reference are told the same thing, and neither can drift.

import type { SubscriberStatus, SuppressionReason } from "./subscribers";

/** What each consent state means. */
export const STATUS_MEANING: Record<SubscriberStatus, string> = {
  pending: "Subscribed but hasn’t clicked the confirmation email.",
  confirmed:
    "Receives your posts. They confirmed here, or opted in at the service you imported them from.",
  unsubscribed: "Opted out, themselves or by asking you.",
};

/** What being suppressed means, whatever the reason. */
export const SUPPRESSED_MEANING =
  "The address isn’t sent your posts, whatever its status. The status stays as it was, greyed while the suppression keeps it from taking effect.";

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
  blocked: "Stopped by hand, by you or at the service it was imported from. You can unblock it.",
  erased:
    "Erased at their request, then signed up again. Only their confirmation email is sent, and confirming lifts this.",
};

/**
 * What an erasure's marker means wherever an address may have no subscriber, as in the
 * list of suppressions: the roster only ever shows it on someone who signed up again.
 */
export const ERASED_MARKER_MEANING =
  "Erased at their request: only the address is kept, so it isn’t mailed, and only the person’s own confirmation of a new sign-up lifts it.";

/** An act on a subscriber: its name in the editor's row menu, and when it is the one to use. */
export interface SubscriberAction {
  label: string;
  when: string;
}

/**
 * The acts on a subscriber, each recording whose decision it was: an unsubscribe and an
 * erasure are the person's, made on their request; a block is the publisher's own, and so
 * is clearing a bounce or complaint, which overrides the provider's verdict.
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
  clear: {
    label: "Clear",
    when: "When you know a bounce’s cause is gone, such as a reader who tells you their mailbox is fixed, or when someone who marked your mail as spam asks you for it again. Mail goes again to an address that failed or reported spam.",
  },
  erase: {
    label: "Erase",
    when: "When they ask you to delete their data. It can’t be undone.",
  },
} satisfies Record<string, SubscriberAction>;
