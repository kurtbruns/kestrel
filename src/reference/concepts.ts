/**
 * The concepts the API reference states once, ahead of the routes (SPEC §11): the rules every
 * route follows (docs/API.md's principles, in the words a client needs), how a list pages, and
 * how a client follows changes to sends. A route then says only what is its own. Claude reads
 * the reference at the start of every conversation and never docs/API.md, so what a client
 * must know about the whole API lives here.
 */

import type { ReferenceConcept } from "../../shared/reference";
import { STUCK_THRESHOLD_MS } from "../../shared/sends";
import { MISSED_THRESHOLD_MS } from "../lib/time";
import { SETTLE_FOLLOW_MS } from "../send/feed";

const RULES = [
  "**One shape per resource.** A resource reads the same on every route that carries it: in a list, alone, in the feed, and in the answer to an act or a refusal. Keep one copy and update it from whichever answer arrives; of two copies of a send, the higher `rev` is newer. Times are epoch milliseconds, and a body is JSON (`Content-Type: application/json`) unless the route names another type.",
  "**Read `actions` and `conditions`; don't work them out.** A send carries exactly what the server would accept on it now (`actions`, each with its method and path) and what is wrong with it (`conditions`), in words to show or relay as they stand. Offer only those acts.",
  "**Every act is safe to repeat.** Acting twice on the same decision answers success with `changed: false`, so a client that lost an answer sends the act again. An act on a send carries no precondition on the send you read (an `If-Match` is ignored): it applies to the send as it stands, and the answer shows the result. A repeated erasure answers `not_found`, since nothing of the subscriber is kept.",
  "**Save against the revision you read.** A post save names the revision it was based on, as `base_revision` or `If-Match`, and is refused without one or once another save has landed, so no one's paragraph is overwritten unseen.",
  "**A refusal names the next move.** Every refusal is `{ error, message }` with its status: show `message` as it stands. One about the request names the `field` (a dotted path for a nested one); one about a resource's state carries the resource as it stands (an act on a send carries `send`), and `retry_after` when waiting is the remedy. The table below groups every code by what to do next.",
  "**Strict at the door.** Each route lists only the refusals of its own. Every admin route also answers 401 `unauthorized` without a credential; every admin write 403 `cross_site_request` when another site's page sent it, and 415 `unsupported_media_type` for a body type it doesn't take. Any route answers 400 `bad_request` naming the `field` for a body or query value it can't take, nothing dropped or defaulted, and 404 `not_found` when a path's id names nothing.",
];

const LISTS =
  "A list answers its rows and `page`: `{ total, limit, offset, sort, dir }`. `limit` is the page size (default 50, at most 200; a larger one is held to 200) and `offset` the rows to skip. A `sort` or `dir` the route doesn't list, or a `limit` or `offset` that isn't a whole number, is a 400 naming the field. The export pages by its own `next` instead, and the send feed doesn't page.";

const FOLLOWING = [
  "Every read of sends answers a `cursor`: `<seq>.<at>`, the change sequence at the read and the server's time of it, both decimal. Every change to a send (a cancel, a move, a re-make, a new schedule, dispatch progress, a receipt) takes the next number in that sequence, and becomes the send's `rev`. The format is part of the contract: a client holding cursors from several reads may compare them and follow everything from one, since the cursor with the smaller of each number answers for both.",
  `To keep up, pass a cursor to \`GET /api/sends/feed\` as \`since\`. It answers every send that changed after it, every send the clock changed with no write (one whose fire time passed, one past the ${MISSED_THRESHOLD_MS / 60_000}-minute missed tolerance, one idle past the ${STUCK_THRESHOLD_MS / 60_000}-minute stuck threshold), every send removed (\`removed\`, each \`{ id, rev }\`, so a client drops it), every open condition across the sends, a new \`cursor\`, and when to read again. \`GET /api/sends\` and \`GET /api/sends/:id\` carry no pace of their own: a client following from one of them reads the feed at once, then keeps to its \`read_again_at\`. Without \`since\`, the feed answers every send that can change on its own: due, \`sending\`, or settling (\`sent\` within the last ${SETTLE_FOLLOW_MS / 60_000} minutes with a recipient awaiting a receipt).`,
  "`read_again_at` is when to read again, by the server's clock (`now`), from each unfinished send's `next_change_at`: about 3 seconds while any send can move now; while sends are only settling, 3 seconds, then 15, then 60, by how long ago the youngest finished dispatch; otherwise about once a minute (one sweep tick); and never later than just past the next change the clock or the sweep will make. A send waiting on a person doesn't quicken it. It is advisory: reading sooner, as right after acting, is always fine, and reading late loses nothing, since the next read from the last cursor reports every send that changed in between.",
  "A read reports at most `limit` changes after the cursor, in the order they were made, and never splits the changes one write made. When more are waiting, `more` is true, `cursor` stands where the read stopped, and `read_again_at` is `now`: read again at once. A cursor ahead of this database, as after a reset or a restore, is refused with `cursor_ahead`: read the sends again and follow from that read's cursor.",
];

/** The concepts, in the order the reference lists them. */
export function referenceConcepts(): ReferenceConcept[] {
  return [
    { key: "rules", title: "Rules every route follows", text: RULES.join("\n\n") },
    { key: "lists", title: "Lists", text: LISTS },
    { key: "following", title: "Following changes", text: FOLLOWING.join("\n\n") },
  ];
}
