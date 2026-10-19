/**
 * Every code the API refuses with: its status, and what it means, grouped by the client's next
 * move, the groups in the order a request meets them (its credential, then what it sends, then
 * whether what it names exists, then that thing's state, then the deployment) and the codes in
 * each by status, then in the order the reference lists their routes. A route's `errors` names
 * its codes from this list, so the reference can't document a
 * code the API never gives, and the status is read from here rather than restated on each
 * route. The reference states each code where it applies (a route's own, with its group's move
 * as the next step; the few no route lists, under Errors); docs/API.md ("Refusing")
 * groups the same codes the same way, and a spec holds the two to the same codes.
 */

import type { ReferenceRefusalGroup, ReferenceStatus } from "../../shared/reference";

/** One code: its status, and one line on it. The fields a refusal carries are each route's
 *  (`details`), so the line never names them, or a route would say them twice. */
type Refusal = readonly [status: number, meaning: string];

const FIX_REQUEST = {
  bad_request: [400, "A body or query value it can't take, naming `field`."],
  subject_required: [400, "Scheduling a post with an empty subject."],
  fire_at_too_soon: [
    400,
    "A fire time inside the minimum lead; Send a post now is the soonest send.",
  ],
  slug_invalid: [
    400,
    "A slug set by hand that isn't lowercase letters and numbers joined by single hyphens.",
  ],
  unrecognized_format: [400, "A file that isn't in the import format at all: convert it."],
  invalid_field: [400, "A column or value the format doesn't take."],
  too_many_rows: [400, "Over this deployment's import `limit`: split the file."],
  body_too_large: [413, "Over a fixed size: split the file."],
  unsupported_media_type: [415, "A body type the route doesn't take."],
  base_required: [428, "A post save without the revision it was based on."],
} as const satisfies Record<string, Refusal>;

const READ_AGAIN = {
  stale_revision: [409, "Another save landed since the revision a post save named."],
  slug_taken: [409, "Another post holds the slug: choose another."],
  active_send_exists: [409, "The post already has its one active send."],
  cursor_ahead: [409, "A cursor ahead of this database: read again, follow from that cursor."],
  plan_stale: [409, "The import's plan changed: plan again."],
  suppression_changed: [
    409,
    "The address's suppression isn't the `reason` a lift named: decide again on the one standing.",
  ],
} as const satisfies Record<string, Refusal>;

const TRY_AGAIN = {
  settings_changed: [409, "A template or identity save landed while a send froze."],
  run_in_progress: [409, "A send run holds what was asked about."],
  conflict: [409, "Settings written at the same moment."],
  remake_too_close: [409, "A send the change would re-make is inside the minimum lead."],
} as const satisfies Record<string, Refusal>;

const CONFIRM = {
  erasure_acknowledgement_required: [
    409,
    "Adding an erased address: send `acknowledge_erasure: true` once the person asked to join again.",
  ],
  attestation_required: [409, "The publisher accepts the `attestation` shown."],
  sends_acknowledgement_required: [
    409,
    "Acknowledge the growing `sends`; a service token can't, so a person finishes it.",
  ],
  remake_required: [409, "Name the sends the change would re-make, in `remake`."],
} as const satisfies Record<string, Refusal>;

const NO_LONGER_APPLIES = {
  not_found: [404, "Nothing has that id."],
  post_not_draft: [
    409,
    "A change only a draft takes, on a scheduled or sent post; its message says whether canceling would unlock it.",
  ],
  slug_permanent: [409, "A change to the slug of a post whose address is fixed."],
  window_closed: [409, "The send's fire time has passed."],
  send_canceled: [409, "The send is canceled: schedule the post again instead."],
  not_wedged: [409, "Nothing on the send needs resolving."],
  erasure_marker: [409, "Lifting an erasure's marker, which only the person's confirmation lifts."],
} as const satisfies Record<string, Refusal>;

const FIX_DEPLOYMENT = {
  invalid_config: [500, "The configuration is refused, naming the `variable`."],
  schema_behind: [500, "The database is behind the release, listing what's `missing`."],
  settings_corrupt: [500, "The stored settings can't be read; the server log says why."],
  internal_error: [500, "An error nothing handled."],
  confirmation_not_sent: [502, "The provider refused a confirmation, or never answered."],
  notify_failed: [502, "The notifications channel refused a test, in its own words."],
  provider_not_connected: [503, "No email provider is connected, so nothing can be sent."],
} as const satisfies Record<string, Refusal>;

const SIGN_IN = {
  unauthorized: [401, "No credential, or one the deployment can't verify."],
  forbidden: [403, "A credential this route doesn't take."],
  cross_site_request: [403, "A write another site's page sent with the publisher's session."],
} as const satisfies Record<string, Refusal>;

/** The groups, in the order the reference lists them. */
const GROUPS: { move: string; codes: Record<string, Refusal> }[] = [
  { move: "Sign in, or stop", codes: SIGN_IN },
  { move: "Fix the request", codes: FIX_REQUEST },
  { move: "Nothing: the act no longer applies", codes: NO_LONGER_APPLIES },
  { move: "Read again, then decide", codes: READ_AGAIN },
  { move: "Try again shortly, unchanged", codes: TRY_AGAIN },
  { move: "Confirm, then send again", codes: CONFIRM },
  { move: "Fix the deployment, outside this API", codes: FIX_DEPLOYMENT },
];

const ALL = {
  ...SIGN_IN,
  ...FIX_REQUEST,
  ...NO_LONGER_APPLIES,
  ...READ_AGAIN,
  ...TRY_AGAIN,
  ...CONFIRM,
  ...FIX_DEPLOYMENT,
};

/** A code the API refuses with: the `error` of a refusal's body. */
export type RefusalCode = keyof typeof ALL;

/** The status each code carries. */
export const REFUSAL_STATUS = Object.fromEntries(
  Object.entries(ALL).map(([code, [status]]) => [code, status]),
) as { [C in RefusalCode]: (typeof ALL)[C][0] };

/** What each code means, and the client's next move on it, by code. */
export const REFUSAL_MEANING = Object.fromEntries(
  Object.entries(ALL).map(([code, [, meaning]]) => [code, meaning]),
) as Record<RefusalCode, string>;
export const REFUSAL_MOVE = Object.fromEntries(
  GROUPS.flatMap(({ move, codes }) => Object.keys(codes).map((code) => [code, move])),
) as Record<RefusalCode, string>;

/** The groups, each code with its status and meaning, as the reference carries them. */
export function refusalGroups(): ReferenceRefusalGroup[] {
  return GROUPS.map(({ move, codes }) => ({
    move,
    codes: Object.entries(codes).map(([code, [status, meaning]]) => ({ code, status, meaning })),
  }));
}

/**
 * Every HTTP status the API answers, success first, each with its name and what it means here:
 * the summary the reference shows beside the refusal codes. A spec holds it to the statuses the
 * codes above carry, so a refusal can't answer a status this list leaves out.
 */
export const STATUSES: ReferenceStatus[] = [
  { status: 200, name: "OK", meaning: "It worked." },
  {
    status: 201,
    name: "Created",
    meaning: "It worked, and made something: a send, an image, an import.",
  },
  {
    status: 400,
    name: "Bad Request",
    meaning: "A value the request can't use; most name the `field`.",
  },
  { status: 401, name: "Unauthorized", meaning: "No credential, or one that can't be verified." },
  {
    status: 403,
    name: "Forbidden",
    meaning: "A credential this route doesn't take, or a write from another site's page.",
  },
  { status: 404, name: "Not Found", meaning: "Nothing has that id." },
  {
    status: 409,
    name: "Conflict",
    meaning:
      "The state of what it acts on refuses it; the code says whether to read again, wait, or confirm.",
  },
  { status: 413, name: "Content Too Large", meaning: "A body over a fixed size." },
  { status: 415, name: "Unsupported Media Type", meaning: "A body type the route doesn't take." },
  {
    status: 428,
    name: "Precondition Required",
    meaning: "A post save without the revision it was based on.",
  },
  {
    status: 500,
    name: "Internal Server Error",
    meaning:
      "The instance needs fixing: its configuration, its database, or an error nothing handled.",
  },
  {
    status: 502,
    name: "Bad Gateway",
    meaning: "The email provider or the notifications channel refused, in its own words.",
  },
  {
    status: 503,
    name: "Service Unavailable",
    meaning: "No email provider is connected, so nothing can be sent.",
  },
];
