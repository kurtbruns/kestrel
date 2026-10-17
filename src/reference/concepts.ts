/**
 * The topics the API reference states once, ahead of the routes (SPEC §11): authentication,
 * requests, errors, paging, acting safely, and following changes, each a few plain sentences carrying
 * docs/API.md's principles in the words a client needs. A route then says only what is its own. Claude reads
 * the reference at the start of every conversation and never docs/API.md, so what a client
 * must know about the whole API lives here.
 */

import type { ReferenceConcept } from "../../shared/reference";
import { STUCK_THRESHOLD_MS } from "../../shared/sends";
import { MISSED_THRESHOLD_MS } from "../lib/time";
import { SETTLE_FOLLOW_MS } from "../send/feed";

const REQUESTS = [
  "A body is JSON (`Content-Type: application/json`) unless the route names another type, and times are epoch milliseconds.",
  "The status says how it went:\n- 2xx: it worked.\n- 4xx: a refusal about the request or the state of what it acts on; Errors says what to do about each.\n- 5xx: the instance itself needs fixing where it is deployed, which nothing sent through this API can do.",
];

const AUTHENTICATION = [
  "Admin routes need a credential. Once deployed, the Cloudflare Access layer issues it: a person's sign-in for the web editor, or a service token for Claude and other automation, sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. On a local instance a dev token stands in, sent as `Authorization: Bearer <token>`. Public routes take no credential. Webhooks are signed by the email provider and verified by the instance.",
];

const ERRORS = [
  "A refusal is `{ error, message }` with its HTTP status, and `message` is written to show or relay as it stands. One about the request names the `field` (a dotted path for a nested one). One about a resource's state carries the resource as it now stands, as an act on a send carries `send`, and `retry_after` when waiting is the remedy.",
  "Each route lists the refusals of its own. Any admin route can also refuse a missing credential (401 `unauthorized`), a write another site's page sent (403 `cross_site_request`), a body type it doesn't take (415), a value it can't read (400 `bad_request`, naming the `field`), and an id that names nothing (404 `not_found`).",
];

const ACTING = [
  "A send says what can be done with it now: `actions` lists exactly the acts the server would accept, each with its method and path, and `conditions` says what is wrong, in words to show. Offer those rather than working them out from other fields.",
  "Repeating an act is safe, so after a lost answer, send it again: one that already took effect answers success, and each route says how its repeat reads (`changed: false` on Cancel a send and Reschedule a send, `idempotent` on Send a post now, `replayed` on Commit an import). An act on a send applies to the send as it stands, whatever you last read of it. Saving a post is the exception: a save names the revision it was based on (`base_revision` or `If-Match`) and is refused once someone else has saved, so no edit is overwritten unseen.",
];

const LISTS =
  "A list answers its rows and `page`: `{ total, limit, offset, sort, dir }`. `limit` is the page size (default 50, at most 200; a larger one is held to 200) and `offset` the rows to skip. A `sort` or `dir` the route doesn't list, or a `limit` or `offset` that isn't a whole number, is a 400 naming the field. Export the list (`GET /api/subscribers/export`) pages by its own `next` instead, and the send feed doesn't page.";

const FOLLOWING = [
  "A resource reads the same on every route that returns it, so keep one copy and replace it from whichever answer arrives. Of two copies of a send, the higher `rev` is newer: every change to a send takes the next number in one sequence across all sends.",
  "Every read of sends also answers a `cursor`, `<seq>.<at>`: where that sequence stood and the server's time. To keep up, pass it to `GET /api/sends/feed` as `since`.",
  `The feed answers every send that changed after that cursor, including those the clock changed with no write (a fire time passing, the ${MISSED_THRESHOLD_MS / 60_000}-minute missed tolerance, the ${STUCK_THRESHOLD_MS / 60_000}-minute stuck threshold), the sends \`removed\`, every open condition, a new \`cursor\`, and \`read_again_at\`. Without \`since\`, it answers the sends that can change on their own: due, sending, or settling (sent within ${SETTLE_FOLLOW_MS / 60_000} minutes).`,
  "`read_again_at` is the server's pace: about 3 seconds while a send can move, slowing to a minute while none can. It is advisory: reading sooner, as right after acting, is fine, and reading late loses nothing. When `more` is true, read again at once. A cursor ahead of the database, as after a restore, is refused with `cursor_ahead`: read the sends again and follow from that read.",
];

/** The topics, in the order the reference lists them. */
export function referenceConcepts(): ReferenceConcept[] {
  return [
    { key: "authentication", title: "Authentication", text: AUTHENTICATION.join("\n\n") },
    { key: "requests", title: "Requests", text: REQUESTS.join("\n\n") },
    { key: "errors", title: "Errors", text: ERRORS.join("\n\n") },
    { key: "lists", title: "Lists and paging", text: LISTS },
    { key: "acting", title: "Acting safely", text: ACTING.join("\n\n") },
    { key: "following", title: "Following changes", text: FOLLOWING.join("\n\n") },
  ];
}
