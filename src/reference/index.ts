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
import type {
  Access,
  ReferenceEntry,
  ReferenceGroup,
  ReferenceResource,
  Resource,
} from "../../shared/reference";
import type { RouteDef } from "../router";

// The entry and group shapes live in shared/ so the editor reads the same definitions;
// re-exported here as the reference's own.
export type { ReferenceEntry, ReferenceGroup };

/** Tier order + copy for the reference. Mirrors the public/admin/webhook split app.ts draws;
 * the titles are the tiers' own names, short enough to sit as a chip row on a phone. */
const TIERS: { access: Access; title: string; blurb: string }[] = [
  {
    access: "admin",
    title: "Admin",
    blurb:
      "The editor and authoring API. Authentication gates it: Cloudflare Access when deployed, a dev token locally. Claude calls these with its service token.",
  },
  {
    access: "public",
    title: "Public",
    blurb:
      "Served to everyone, no login: the archive, subscribe/confirm/unsubscribe, and media. Protected where needed by unguessable per-subscriber tokens.",
  },
  {
    access: "webhook",
    title: "Webhooks",
    blurb:
      "Delivery callbacks from the email provider. They carry no auth middleware; each request is signature-verified inside its adapter.",
  },
];

/**
 * Each resource's heading, in the order the reference lists them within a tier: the
 * publication's own work first (posts, then their sends, then the list), the plumbing
 * last. A Record, so a new `Resource` fails to compile until it is titled and placed.
 */
const RESOURCE_TITLES: Record<Resource, string> = {
  posts: "Posts",
  sends: "Sends",
  subscribers: "Subscribers",
  suppressions: "Suppressions",
  subscriptions: "Subscriptions",
  archive: "Archive",
  media: "Media",
  delivery: "Delivery events",
  settings: "Settings",
  system: "System",
  dev: "Development",
};
const RESOURCE_ORDER = Object.keys(RESOURCE_TITLES) as Resource[];

/** The metadata the reference shows for one route (no handler/middleware). */
function entry(r: RouteDef): ReferenceEntry {
  return {
    method: r.method,
    path: r.path,
    access: r.access,
    resource: r.resource,
    summary: r.summary,
    description: r.description,
    query: r.query,
    example: r.example,
  };
}

/**
 * Group the manifest by access tier, listing the resources each tier's routes declare (in
 * RESOURCE_TITLES order) and its routes in that order, registration order within each
 * resource. Returned as data so tests can assert coverage and grouping without parsing HTML.
 */
export function buildReference(routes: readonly RouteDef[]): ReferenceGroup[] {
  return TIERS.map(({ access, title, blurb }) => {
    const inTier = routes.filter((r) => r.access === access);
    const keys = RESOURCE_ORDER.filter((key) => inTier.some((r) => r.resource === key));
    return {
      access,
      title,
      blurb,
      resources: keys.map((key): ReferenceResource => ({ key, title: RESOURCE_TITLES[key] })),
      routes: keys.flatMap((key) => inTier.filter((r) => r.resource === key).map(entry)),
    };
  }).filter((g) => g.routes.length > 0);
}
