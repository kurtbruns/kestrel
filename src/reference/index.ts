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
import { REFUSAL_STATUS } from "./refusals";

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
  imports: "Imports",
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
    title: r.title,
    summary: r.summary,
    description: r.description,
    query: r.query,
    accepts: r.accepts,
    body: r.body,
    errors: r.errors?.map((e) => ({ status: REFUSAL_STATUS[e.code], ...e })),
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

/** The refusals every route of a tier shares, stated once rather than on each route. */
const SHARED_REFUSALS =
  "A refusal is `{ error, message }` with its status, plus `field` when it is about the request. Each route lists only the refusals of its own. Every admin route also answers 401 `unauthorized` without a credential, and every admin write 403 `cross_site_request` when another site's page sent it and 415 `unsupported_media_type` for a body type it doesn't take. Any route answers 400 `bad_request` naming the `field` for a body or query value it can't take, and 404 `not_found` when a path's id names nothing.";

/** A JSON value as a fenced block, for an example. */
function jsonBlock(label: string, value: unknown): string {
  return `${label}:\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** Text for a Markdown table cell, whose pipes would otherwise split it. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** One route as a Markdown section: its title as the heading, its method and path beneath,
 *  then the summary, description, body types, query parameters, body fields, its own
 *  refusals, and example. */
function routeMarkdown(r: ReferenceEntry): string {
  const parts = [`#### ${r.title}`, `\`${r.method} ${r.path}\``, r.summary];
  if (r.description) {
    parts.push(r.description);
  }
  if (r.accepts?.length) {
    parts.push(`Body: ${r.accepts.map((t) => `\`${t}\``).join(", ")}.`);
  }
  if (r.query?.length) {
    const rows = r.query.map(
      (q) => `| \`${q.name}\`${q.required ? " (required)" : ""} | ${cell(q.description)} |`,
    );
    parts.push(["| Query parameter | Description |", "| --- | --- |", ...rows].join("\n"));
  }
  if (r.body?.length) {
    const rows = r.body.map(
      (f) =>
        `| \`${f.name}\`${f.required ? " (required)" : ""} | ${cell(f.type)} | ${cell(f.description)} |`,
    );
    parts.push(["| Body field | Type | Description |", "| --- | --- | --- |", ...rows].join("\n"));
  }
  if (r.errors?.length) {
    const rows = r.errors.map(
      (e) =>
        `| ${e.status} \`${e.code}\` | ${cell(e.when)}${e.details?.length ? ` With ${e.details.map((d) => `\`${d}\``).join(", ")}.` : ""} |`,
    );
    parts.push(["| Refusal | When |", "| --- | --- |", ...rows].join("\n"));
  }
  if (r.example?.request !== undefined) {
    parts.push(jsonBlock("Example request", r.example.request));
  }
  if (r.example?.response !== undefined) {
    parts.push(jsonBlock("Example response", r.example.response));
  }
  return parts.join("\n\n");
}

/**
 * The reference as one Markdown document, for an agent to read (SPEC §11): a `##` heading per
 * tier, a `###` per resource within it, and a `####` per route, named by its title. A projection of the same
 * groups `buildReference` returns, so it can't drift from the JSON. `origin` is the base URL
 * the paths hang off.
 */
export function referenceMarkdown(groups: readonly ReferenceGroup[], origin: string): string {
  const head = `# API reference\n\nEvery route this instance serves, generated from its registration, so every endpoint the editor and Claude can call is listed here. Base URL \`${origin}\`. Admin routes take the same authentication as the editor: Claude sends its service token.\n\n${SHARED_REFUSALS}`;
  const tiers = groups.map((g) => {
    const resources = g.resources.map((res) =>
      [
        `### ${res.title}`,
        ...g.routes.filter((r) => r.resource === res.key).map(routeMarkdown),
      ].join("\n\n"),
    );
    return [`## ${g.title}`, g.blurb, ...resources].join("\n\n");
  });
  return `${[head, ...tiers].join("\n\n")}\n`;
}
