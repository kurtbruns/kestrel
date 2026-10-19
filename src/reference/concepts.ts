/**
 * The topics the API reference states once, ahead of the routes (SPEC §11): authentication,
 * requests, errors, paging, and acting safely, each a few plain sentences carrying
 * docs/API.md's principles in the words a client needs. A route then says only what is its own. Claude reads
 * the reference at the start of every conversation and never docs/API.md, so what a client
 * must know about the whole API lives here. What one resource's routes share stays with that
 * resource, as following sends is told on the feed route.
 */

import type { ReferenceConcept, ReferenceField } from "../../shared/reference";

const REQUESTS = [
  "A body is JSON (`Content-Type: application/json`) unless the route names another type, and so is an answer unless the route says it answers a file or a page (a CSV export, an email preview). Times are epoch milliseconds.",
  "Every field name and every value from a fixed set (a `status`, a `phase`, a condition's `kind`) is snake_case, in a request and in an answer, and so is a query parameter and its value. A list's `sort` is the name of the field it sorts by, a dotted path for a nested one (`audience.count`). A path segment is a URL, not JSON, and keeps its own form.",
];

const AUTHENTICATION = [
  "Admin routes need a credential. Once deployed, the Cloudflare Access layer issues it: a person's sign-in for the web editor, or a service token for Claude and other automation, sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. On a local instance a dev token stands in, sent as `Authorization: Bearer <token>`. Public routes take no credential. Webhooks are signed by the email provider and verified by the instance.",
];

const ERRORS = [
  "Kestrel answers with the usual HTTP statuses:\n- Codes in the `2xx` range mean it worked.\n- Codes in the `4xx` range are a refusal about the request or the state of what it acts on. Its code says what to do next.\n- Codes in the `5xx` range mean the instance itself needs fixing where it is deployed, which nothing sent through this API can do.",
  "A refusal's body names its code and says why, in words to show or relay as they stand. Each route lists the refusals it gives, each with what to do next; the few any route can give are listed here.",
];

/** A refusal's body, field by field. */
const ERROR_BODY: ReferenceField[] = [
  {
    name: "error",
    type: "string",
    description:
      "The refusal's code: a route lists the ones it gives, and those any route can give are below.",
  },
  {
    name: "message",
    type: "string",
    description: "Why, written to show the publisher or relay as it stands.",
  },
  {
    name: "field",
    type: "string",
    description:
      "The body or query field a refusal is about, a dotted path for a nested one (`notifications.to`). Every refusal whose next move is to fix the request carries it when one field is at fault, so a route doesn't list it there; a body it can't read at all, or a fault in the path, names none. A route lists it on any other refusal that carries it (`slug_taken`).",
  },
  {
    name: "retry_after",
    type: "epoch ms",
    description: "When waiting is the remedy: when to try again.",
  },
  {
    name: "send, post, …",
    type: "object",
    description:
      "For a refusal about a resource's state: the resource as it now stands, whole, as an answer carries it: a `post`, the `settings`, a `subscriber`, a `suppression`, or a `send` with the `cursor` to follow it from. An import's `plan_stale` carries no plan: plan again.",
  },
];

const ACTING = [
  "A post and a send list in `actions` exactly the acts the server would accept now, each with its method and path, and a send's `conditions` say what is wrong, in words to show. Both are the server's own answer, so a client can show them as they stand instead of deriving them from `status` or `phase`, and stays right when the rules behind them change.",
  "Repeating an act is safe: after a lost answer, send it again, and one that already took effect answers success, in the way its route describes. An act on a send applies to the send as it stands, whatever you last read of it, so read its answer to see what it did. Saving a post is the exception: a save names the revision it was based on and is refused once someone else has saved, so no edit is overwritten unseen.",
  "A resource reads the same on every route that returns it, and every answer and refusal about one carries it as it now stands, so keep one copy and replace it from whichever answer arrives.",
];

const LISTS =
  "A list answers its rows and `page`: `{ total, limit, offset, sort, dir }`. `limit` is the page size (default 50, at most 200; a larger one is held to 200) and `offset` the rows to skip. A `sort` or `dir` the route doesn't list, or a `limit` or `offset` that isn't a whole number, is a 400 naming the field. A list that pages on its own order instead (the export, a subscriber's sends) answers `next` in place of `page`: pass it back as `after` for the page that follows, until it is null. The server sets such a page's size.";

/** The topics, in the order the reference lists them. */
export function referenceConcepts(): ReferenceConcept[] {
  return [
    { key: "authentication", title: "Authentication", text: AUTHENTICATION.join("\n\n") },
    { key: "requests", title: "Requests", text: REQUESTS.join("\n\n") },
    { key: "errors", title: "Errors", text: ERRORS.join("\n\n"), fields: ERROR_BODY },
    { key: "lists", title: "Lists and paging", text: LISTS },
    { key: "acting", title: "Acting safely", text: ACTING.join("\n\n") },
  ];
}
