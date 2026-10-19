// How a subscriber's state reads wherever it is drawn: the roster's row and their own page
// draw the status pill, the words beside it, and the suppression flag the same way.

import { SUPPRESSION_FLAG } from "../../shared/subscriber_meanings";
import type { Subscriber } from "../../shared/subscribers";
import { type Html, html } from "../ui/html";
import { badge } from "../ui/widgets";

/** The flag a suppression shows as; anything unrecognized falls back to a generic label. */
export function flagLabel(s: Subscriber): string {
  return (s.suppression && SUPPRESSION_FLAG[s.suppression.reason]) || "suppressed";
}

/**
 * The red flag beside the address (suppression is a deliverability overlay, not a consent
 * status) naming WHY, which also says whose decision it was: bounced (the provider's, or the
 * previous service's for an import) or blocked (the publisher's). The pills carry no hover
 * tooltip, which keyboard, screen-reader, and touch users can't reach: the legend defines each
 * label once, and a subscriber's own detail is on their page.
 */
export function suppressionFlag(s: Subscriber): Html | null {
  if (!s.suppression) {
    return null;
  }
  return html` <span class="badge suppressed row-flag">${flagLabel(s)}</span>`;
}

/**
 * The status pill. A suppressed address keeps its consent status, but the status isn't in
 * effect while the suppression stands, so its badge takes the not-mailed grey (DESIGN §3). Why
 * an unsubscribed subscriber left is their own detail, on their page, not beside the badge.
 */
export function statusBadge(s: Subscriber): Html {
  return s.suppression
    ? html`<span class="badge ${s.status} held">${s.status}</span>`
    : badge(s.status);
}

/** An address that has to wrap breaks before its "@", keeping the mailbox and the domain
 *  whole where they fit, rather than wherever the column runs out. */
export function breakableEmail(email: string): Html {
  const at = email.lastIndexOf("@");
  return at > 0 ? html`${email.slice(0, at)}<wbr>${email.slice(at)}` : html`${email}`;
}

/** Whether the subscriber was erased: unsubscribed by an erasure, holding only the address. */
export function isErased(s: Subscriber): boolean {
  return s.status === "unsubscribed" && s.unsubscribe_cause === "erased";
}

/** The subscriber's own page (DESIGN §3), as a hash route. The id is the server's, put in
 *  the route as it is, as a send's is in `#/sent/:send`. */
export function subscriberHref(id: string): string {
  return `#/subscribers/${id}`;
}
