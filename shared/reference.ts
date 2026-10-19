// The API reference as the API carries it (GET /api/reference): the concepts and objects it
// describes once, the access tiers the route manifest draws, the resources inside them, one
// route's documented metadata, and the routes grouped by tier.
// The Worker generates this shape from its own registration and the editor renders it;
// one definition, so neither can drift.

/**
 * The access tier a route is served at. `admin` is gated by the app's auth; `public`
 * (reader/subscribe/archive/media) and `webhook` (provider callbacks, verified inside the
 * adapter) carry no auth middleware.
 */
export type Access = "admin" | "public" | "webhook";

/**
 * What a route acts on, declared on its registration so the reference groups by it
 * instead of guessing from the path. The Worker titles and orders them.
 */
export type Resource =
  | "system"
  | "dev"
  | "settings"
  | "posts"
  | "sends"
  | "subscribers"
  | "imports"
  | "suppressions"
  | "subscriptions"
  | "archive";

/** A worked request/response pair for the API reference. Hand-authored, co-located with the route. */
export interface RouteExample {
  request?: unknown;
  response?: unknown;
}

/** A documented query parameter, for list routes with filter/sort/pagination. */
export interface QueryParam {
  name: string;
  description: string;
  /** The route can't be called without it (a token-scoped link), unlike a list's optional filters. */
  required?: boolean;
  /** The values it takes, when they are a fixed set; on the API any other is refused, naming
   *  the parameter. Absent for a free value (a search, a cursor, a number), whose route checks it. */
  values?: readonly string[];
  /** It takes several of `values` at once, as a comma list (`draft,scheduled`). */
  list?: boolean;
}

/**
 * A documented field, of a request body, a response, or an object. A nested field is named by
 * its dotted path (`publication.name`), as a 400 names it in `field`. `type` is a short human
 * string (`string`, `number | null`, `"unsent" | "accepted"`, `file`), not a schema.
 */
export interface ReferenceField {
  name: string;
  type: string;
  description: string;
  /** An enum's values, each with one line of meaning, and the group it is listed under when the
   *  values fall into kinds (a halt cause's halt). */
  values?: { value: string; description: string; group?: string }[];
  /** The object the field holds (or a list of), described once in its own section and linked. */
  object?: ObjectKey;
}

/** A documented field of a request body. */
export interface BodyField extends ReferenceField {
  /** The request is refused without it. */
  required?: boolean;
}

/** An object the reference describes once, which routes say they return. */
export type ObjectKey =
  | "send"
  | "condition"
  | "halt"
  | "post"
  | "revision"
  | "subscriber"
  | "suppression"
  | "import_plan"
  | "settings";

/**
 * A table an object carries beside its fields, for a field whose values each have more to say
 * than one line holds (a condition's kind: its severity, its fields, its remedy). Cells are
 * inline Markdown; each row has one cell per column.
 */
export interface ReferenceTable {
  title: string;
  description: string;
  columns: string[];
  rows: string[][];
}

/** An object, described once, at the top of its resource: its fields, each with one line, and an example. */
export interface ReferenceObject {
  key: ObjectKey;
  /** The resource it heads, as Stripe puts "The Customer object" first under Customers. */
  resource: Resource;
  title: string;
  description: string;
  fields: ReferenceField[];
  /** Tables of a field's values, after the fields. */
  tables?: ReferenceTable[];
  example: unknown;
}

/**
 * What a route answers: an object described once (under `as` in the body, a list of them when
 * `list`, or the whole body when `as` is absent), plus only the fields this route adds.
 */
export interface RouteReturns {
  object?: ObjectKey;
  as?: string;
  list?: boolean;
  fields?: ReferenceField[];
}

/** A concept the reference states once, ahead of the routes: Markdown paragraphs. */
export interface ReferenceConcept {
  key: string;
  title: string;
  text: string;
  /** Fields the topic describes, as an object's are (the error body, under Errors). */
  fields?: ReferenceField[];
}

/** One HTTP status the API answers, with its name and what it means here. */
export interface ReferenceStatus {
  status: number;
  name: string;
  meaning: string;
}

/** The refusal codes for one next move, each with its status and one line. */
export interface ReferenceRefusalGroup {
  move: string;
  codes: { code: string; status: number; meaning: string }[];
}

/** A refusal a route gives of its own, beyond the ones every route of its tier shares. */
export interface RouteError {
  status: number;
  /** The `error` the refusal's body carries. */
  code: string;
  /** One line on the condition as this route gives it; absent when the code's own meaning says it all. */
  when?: string;
  /** The fields the body carries beside `error` and `message` (`send`, `retry_after`), less a
   *  `field` on a code under Fix the request, which the Errors topic states once for them all. */
  details?: string[];
  /** The client's next move on it, from the refusal registry ("Read again, then decide"). */
  move: string;
}

/** One route as the reference shows it: the manifest metadata, without handler or middleware. */
export interface ReferenceEntry {
  method: string;
  path: string;
  access: Access;
  resource: Resource;
  /** The route named by what it does ("Schedule a post"); the reference leads with it, the path beneath. */
  title: string;
  summary: string;
  description?: string;
  query?: QueryParam[];
  /** The media types the request body may carry; absent when the route takes no body. */
  accepts?: readonly string[];
  /** The body's fields, a multipart form's included; absent when the route takes no body. */
  body?: BodyField[];
  /** What it answers: an object described once, and the fields of its own. */
  returns?: RouteReturns;
  /** The refusals the route gives of its own; the ones its tier shares are stated once. */
  errors?: RouteError[];
  example?: RouteExample;
}

/** A resource as a tier lists it: its key and its heading. */
export interface ReferenceResource {
  key: Resource;
  title: string;
}

/**
 * The routes of one access tier, with a short heading for the tier and the resources its
 * routes act on, in the order the reference lists them. `routes` runs in that same
 * order, resource by resource, and in registration order within each.
 */
export interface ReferenceGroup {
  access: Access;
  title: string;
  blurb: string;
  resources: ReferenceResource[];
  routes: ReferenceEntry[];
}

/**
 * GET /api/reference: the concepts every route follows, the refusal codes, the objects routes
 * return, and every route, grouped by tier.
 */
export interface ReferenceResponse {
  concepts: ReferenceConcept[];
  /** Every status the API answers, in order: a summary beside the refusal codes. */
  statuses: ReferenceStatus[];
  refusals: ReferenceRefusalGroup[];
  objects: ReferenceObject[];
  groups: ReferenceGroup[];
}

/**
 * The refusals any route can give, which no route lists as its own (a missing credential, a
 * body type it doesn't take, a fault of the deployment's): the ones Errors states once, each
 * with its next move. Every other code is on the routes that give it.
 */
export function sharedRefusals(
  ref: Pick<ReferenceResponse, "refusals" | "groups">,
): (ReferenceRefusalGroup["codes"][number] & { move: string })[] {
  const onRoutes = new Set(
    ref.groups.flatMap((g) => g.routes.flatMap((r) => (r.errors ?? []).map((e) => e.code))),
  );
  return ref.refusals.flatMap((g) =>
    g.codes.filter((c) => !onRoutes.has(c.code)).map((c) => ({ ...c, move: g.move })),
  );
}

/**
 * The route's path as a URL path to type: the pattern syntax a URL never carries (a
 * parameter's regex, an optional segment) is dropped, and `:id`-style parameters stay as
 * the placeholders to replace. The reference shows its rows and builds its commands this way.
 */
export function concretePath(path: string): string {
  return path.replace(/\([^)]*\)/g, "").replace(/\{[^}]*\}\??/g, "") || "/";
}

/**
 * A route's own address in the editor's reference, `#/api-reference/<anchor>`: what it does,
 * the words of its title without the articles or a possessive, joined by hyphens ("Schedule a
 * post" is `schedule-post`, "List a post's revisions" `list-post-revisions`), as Stripe's and
 * Mux's references name theirs. Rewording a title moves its link, so a reword is a choice.
 * Here rather than in the editor so a spec can hold every route's anchor unique.
 */
export function routeAnchor(r: { title: string }): string {
  return r.title
    .toLowerCase()
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "" && w !== "a" && w !== "an" && w !== "the")
    .join("-");
}
