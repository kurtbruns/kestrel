// The one spelling of a link into the editor from outside it (a notification email to the
// publisher), shared by the Worker that writes the link and the editor that opens it, so
// the two can't disagree.
//
// The editor's pages are hash routes (`#/sent/<id>`), but a browser never sends the hash
// to the server, so a login in between (Cloudflare Access, when the publisher isn't
// signed in) returns to `/dashboard/` without it and lands on the editor's home. A link
// from outside carries its route in the query instead, which the login keeps, and the
// editor turns it into the hash at boot.

/** The query parameter that carries the route. */
const PARAM = "to";

/** A link from outside the editor to one of its pages: `route` is the hash route without
 *  its `#` (`/sent/<id>`), each segment already encoded. The route's slashes stay literal,
 *  so the link reads as the page it opens (`…/dashboard/?to=/sent/<id>`). */
export function dashboardLink(appOrigin: string, route: string): string {
  return `${appOrigin}/dashboard/?${PARAM}=${encodeURIComponent(route).replaceAll("%2F", "/")}`;
}

/** A route: `/` and then the characters an encoded segment uses, repeated. */
const ROUTE = /^(\/[A-Za-z0-9._~%-]+)+$/;

/** A segment a URL parser reads as `.` or `..`, spelled out or percent-encoded. The editor
 *  puts a route's segments into API paths as they are, so one of these would climb out of
 *  the path the page meant to read. */
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?=\/|$)/i;

/** Whether `route` (a hash route without its `#`) is one the editor will open: path-shaped,
 *  with no dot segment. The editor checks its hash with this as well as a link's query, so a
 *  route typed into the address bar is held to the same rule as one from an email. */
export function isDashboardRoute(route: string): boolean {
  return ROUTE.test(route) && !DOT_SEGMENT.test(route);
}

/** The hash a link's query names (`#/sent/<id>`), or null when it names none. Only a route
 *  the editor will open is taken, so a mangled or hand-typed query opens the editor's home
 *  rather than a nonsense route. */
export function dashboardRouteFromSearch(search: string): string | null {
  const route = new URLSearchParams(search).get(PARAM);
  return route && isDashboardRoute(route) ? `#${route}` : null;
}
