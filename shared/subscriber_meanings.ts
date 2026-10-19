// What each subscriber label and action means, in the words the publisher reads (SPEC §7).
// The editor's legend and the API reference both print these, so a person in the editor
// and a client reading the reference are told the same thing, and neither can drift.

import type { SubscriberStatus, SuppressionReason, UnsubscribeCause } from "./subscribers";

/** What each consent state means. */
export const STATUS_MEANING: Record<SubscriberStatus, string> = {
  pending: "Subscribed but hasn’t clicked the confirmation email.",
  confirmed:
    "Receives your posts. They confirmed here, or opted in at the service you imported them from.",
  unsubscribed: "Left the list. Why they left is shown beside it.",
};

/** The words beside an unsubscribed status that say why the person left. */
export const CAUSE_LABEL: Record<UnsubscribeCause, string> = {
  reader: "by their link",
  publisher: "on request",
  complaint: "complaint",
  erased: "erased",
  import: "left elsewhere",
};

/** What each reason for leaving means, and what it allows. */
export const CAUSE_MEANING: Record<UnsubscribeCause, string> = {
  reader: "They unsubscribed themselves, from the link or the button in your email.",
  publisher: "You unsubscribed them, when they asked you to.",
  complaint:
    "They reported your email as spam. Only their own sign-up brings them back, so you can’t add them: ask them to subscribe through your subscribe page.",
  erased:
    "You erased them at their request. Only the address is kept, so it isn’t mailed again, and only their own sign-up brings them back.",
  import: "The list you imported says they left, without saying why.",
};

/** What being suppressed means, whatever the reason. */
export const SUPPRESSED_MEANING =
  "The address isn’t sent your posts, whatever its status. The status stays as it was, greyed while the suppression keeps it from taking effect.";

/** The flag a suppression shows as. An import's bounce reads as one seen here. */
export type SuppressionFlag = "bounced" | "blocked";

export const SUPPRESSION_FLAG: Record<SuppressionReason, SuppressionFlag> = {
  bounce: "bounced",
  import_bounce: "bounced",
  manual: "blocked",
};

/** What each flag means, and so whose decision the suppression was. */
export const FLAG_MEANING: Record<SuppressionFlag, string> = {
  bounced:
    "Mail to the address failed, here or at the service it was imported from. You can clear it.",
  blocked: "Stopped by hand, by you or at the service it was imported from. You can unblock it.",
};

/** An act on a subscriber: its name in the editor's row menu, and when it is the one to use. */
export interface SubscriberAction {
  label: string;
  when: string;
}

/**
 * The acts on a subscriber, each recording whose decision it was: an unsubscribe and an
 * erasure are the person's, made on their request; a block and unblocking it are the
 * publisher's own, and so is clearing a bounce, which overrides the provider's verdict.
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
  unblock: {
    label: "Unblock",
    when: "When you decide to mail an address you blocked again. They receive your posts only if they’re confirmed.",
  },
  clear: {
    label: "Clear",
    when: "When you know a bounce’s cause is gone, such as a reader who tells you their mailbox is fixed. Mail goes again to an address that failed.",
  },
  erase: {
    label: "Erase",
    when: "When they ask you to delete their data. They’re unsubscribed and only their address is kept. It can’t be undone, and they come back only by subscribing themselves.",
  },
} satisfies Record<string, SubscriberAction>;
