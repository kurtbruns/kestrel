// The API reference as the API carries it (GET /api/reference): the access tiers the
// route manifest draws, one route's documented metadata, and the routes grouped by tier.
// The Worker generates this shape from its own registration and the editor renders it;
// one definition, so neither can drift.

/**
 * The access tier a route is served at. `admin` is gated by the app's auth; `public`
 * (reader/subscribe/archive/media) and `webhook` (provider callbacks, verified inside the
 * adapter) carry no auth middleware.
 */
export type Access = "admin" | "public" | "webhook";

/** A worked request/response pair for the API reference. Hand-authored, co-located with the route. */
export interface RouteExample {
  request?: unknown;
  response?: unknown;
}

/** A documented query parameter, for list routes with filter/sort/pagination. */
export interface QueryParam {
  name: string;
  description: string;
}

/** One route as the reference shows it: the manifest metadata, without handler or middleware. */
export interface ReferenceEntry {
  method: string;
  path: string;
  access: Access;
  summary: string;
  description?: string;
  query?: QueryParam[];
  example?: RouteExample;
}

/** The routes of one access tier, with a short heading for the tier. */
export interface ReferenceGroup {
  access: Access;
  title: string;
  blurb: string;
  routes: ReferenceEntry[];
}

/** GET /api/reference: every route, grouped by tier in registration order. */
export interface ReferenceResponse {
  groups: ReferenceGroup[];
}
