// The API reference as the API carries it (GET /api/reference): the access tiers the
// route manifest draws, the resources inside them, one route's documented metadata, and
// the routes grouped by tier.
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
  | "suppressions"
  | "subscriptions"
  | "archive"
  | "media"
  | "delivery";

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
}

/** One route as the reference shows it: the manifest metadata, without handler or middleware. */
export interface ReferenceEntry {
  method: string;
  path: string;
  access: Access;
  resource: Resource;
  summary: string;
  description?: string;
  query?: QueryParam[];
  /** The media types the request body may carry; absent when the route takes no body. */
  accepts?: readonly string[];
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

/** GET /api/reference: every route, grouped by tier. */
export interface ReferenceResponse {
  groups: ReferenceGroup[];
}
