/**
 * The in-app API reference, generated from the route manifest (src/app.ts). The
 * registered routes ARE the source: `createRouter` hands its `router.routes` here,
 * so every documented endpoint is a live endpoint and the tier shown is the tier
 * that gates it. Adding a route to the manifest makes it appear here with no
 * second doc to edit — the same principle as `ARCHIVE_BASE_PATH` driving both the
 * emitted URL and the route it serves (SPEC §11).
 *
 * This is a Markdown-free, structured render — distinct from both the operator
 * docs (src/docs/, Markdown→web-page) and the single email render path (I5).
 * Served read-only through the authed `/api/reference` route (see routes/docs.ts
 * for the sibling docs surface it mirrors).
 */
import type { Access, QueryParam, RouteDef } from "../router";

/** One route as the reference shows it: the manifest metadata, without handler or middleware. */
export interface ReferenceEntry {
  method: string;
  path: string;
  access: Access;
  summary: string;
  description?: string;
  query?: QueryParam[];
  example?: { request?: unknown; response?: unknown };
}

/** The routes of one access tier, with a short heading for the tier. */
export interface ReferenceGroup {
  access: Access;
  title: string;
  blurb: string;
  routes: ReferenceEntry[];
}

/** Tier order + copy for the reference. Mirrors the public/admin/webhook split app.ts draws. */
const TIERS: { access: Access; title: string; blurb: string }[] = [
  {
    access: "admin",
    title: "Admin",
    blurb:
      "The editor and authoring API. Authentication gates it: Cloudflare Access when deployed, a dev token locally. Claude calls these with its service token.",
  },
  {
    access: "public",
    title: "Public reader",
    blurb:
      "Served to everyone, no login: the archive, subscribe/confirm/unsubscribe, and media. Protected where needed by unguessable per-subscriber tokens.",
  },
  {
    access: "webhook",
    title: "Provider webhooks",
    blurb:
      "Delivery callbacks from the email provider. They carry no auth middleware; each request is signature-verified inside its adapter.",
  },
];

/**
 * Group the manifest by access tier, in registration order within each tier,
 * projected to the metadata the reference shows (no handler/middleware). Returned
 * as data so tests can assert coverage and tiering without parsing HTML.
 */
export function buildReference(routes: readonly RouteDef[]): ReferenceGroup[] {
  return TIERS.map(({ access, title, blurb }) => ({
    access,
    title,
    blurb,
    routes: routes
      .filter((r) => r.access === access)
      .map((r) => ({
        method: r.method,
        path: r.path,
        access: r.access,
        summary: r.summary,
        description: r.description,
        query: r.query,
        example: r.example,
      })),
  })).filter((g) => g.routes.length > 0);
}
