// The one spelling of a link into the editor from outside it (an email to the publisher:
// a test's view-in-browser link, a notification's link to its send), shared by the Worker
// that writes the link and the editor that opens it, so the two can't disagree.
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

/** The hash a link's query names (`#/sent/<id>`), or null when it names none. Only a
 *  path-shaped route (`/` and then the characters an encoded segment uses) is taken, so
 *  a mangled or hand-typed query opens the editor's home rather than a nonsense route. */
export function dashboardRouteFromSearch(search: string): string | null {
  const route = new URLSearchParams(search).get(PARAM);
  return route && /^(\/[A-Za-z0-9._~%-]+)+$/.test(route) ? `#${route}` : null;
}
