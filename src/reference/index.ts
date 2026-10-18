/**
 * The in-app API reference, generated from the route manifest (src/app.ts). The
 * registered routes ARE the source: `createRouter` hands its `router.routes` here,
 * so every documented endpoint is a live endpoint and the tier shown is the tier
 * that gates it. Adding a route to the manifest makes it appear here with no
 * second doc to edit — the same principle as `ARCHIVE_BASE_PATH` driving both the
 * emitted URL and the route it serves (SPEC §11).
 *
 * Beside the routes it carries what they share, described once: the concepts every route
 * follows (./concepts.ts), the refusal codes (./refusals.ts), and the objects routes return
 * (./objects.ts), so a route's own entry says only what is its own.
 *
 * It is projected two ways: the structured response the editor renders, and Markdown for an
 * agent (an index, and a document per resource). Both are distinct from the operator docs
 * (src/docs/, Markdown→web-page) and the single email render path (I5).
 * Served read-only through the authed `/api/reference`, `/api/reference.md`, and
 * `/api/reference/<resource>.md` routes (see routes/docs.ts for the sibling docs surface).
 */

import { headingAnchor } from "../../shared/docs";
import type {
  Access,
  ObjectKey,
  ReferenceEntry,
  ReferenceField,
  ReferenceGroup,
  ReferenceObject,
  ReferenceResource,
  ReferenceResponse,
  ReferenceTable,
  Resource,
  RouteReturns,
} from "../../shared/reference";
import { sharedRefusals } from "../../shared/reference";
import type { RouteDef } from "../router";
import { referenceConcepts } from "./concepts";
import { OBJECTS, referenceObjects } from "./objects";
import {
  REFUSAL_MEANING,
  REFUSAL_MOVE,
  REFUSAL_STATUS,
  type RefusalCode,
  refusalGroups,
  STATUSES,
} from "./refusals";

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
      "The authoring API, which the web editor and Claude both call, each with its own credential (Authentication, above).",
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
      "Delivery reports from the email provider, each verified by its signature rather than a credential.",
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
    returns: r.returns,
    errors: r.errors?.map((e) => ({
      status: REFUSAL_STATUS[e.code],
      ...e,
      move: REFUSAL_MOVE[e.code],
    })),
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

/** The whole reference: what every route shares, described once, then the routes. */
export function buildReferenceResponse(routes: readonly RouteDef[]): ReferenceResponse {
  return {
    concepts: referenceConcepts(),
    statuses: STATUSES,
    refusals: refusalGroups(),
    objects: referenceObjects(),
    groups: buildReference(routes),
  };
}

/** A link to an object's section: in this resource's own document, or in its resource's. */
function objectLink(key: ObjectKey, from: Resource, text?: string): string {
  const { title, resource } = OBJECTS[key];
  const file = resource === from ? "" : `${resource}.md`;
  return `[${text ?? title}](${file}#${headingAnchor(title)})`;
}

/** Fields as a Markdown table, an enum's values listed in its line. */
/** An enum's values in one cell: each `value: meaning`, under its group's name when they fall into groups. */
function valuesMarkdown(values: NonNullable<ReferenceField["values"]>): string {
  const one = (v: (typeof values)[number]) => `\`${v.value}\`: ${v.description}`;
  const groups = [...new Set(values.map((v) => v.group).filter((g) => g !== undefined))];
  return groups.length
    ? groups
        .map(
          (g) =>
            `${g}: ${values
              .filter((v) => v.group === g)
              .map(one)
              .join(" ")}`,
        )
        .join(" ")
    : values.map(one).join(" ");
}

function fieldTable(fields: readonly ReferenceField[], from?: Resource): string {
  const rows = fields.map((f) => {
    const values = f.values?.length ? ` ${valuesMarkdown(f.values)}` : "";
    // A field that holds an object links its type to that object's section.
    const type = f.object && from ? objectLink(f.object, from, cell(f.type)) : cell(f.type);
    return `| \`${f.name}\` | ${type} | ${cell(f.description + values)} |`;
  });
  return ["| Field | Type | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

/** What a route answers: the object it returns, linked, and the fields of its own. */
function returnsMarkdown(r: RouteReturns, from: Resource): string {
  const what = r.object
    ? r.as
      ? `\`${r.as}\`, ${r.list ? `a list of ${objectLink(r.object, from)}` : objectLink(r.object, from)}`
      : objectLink(r.object, from)
    : "";
  const lead = r.fields?.length
    ? what
      ? `Returns ${what}, and:`
      : "Returns:"
    : `Returns ${what}.`;
  return r.fields?.length ? `${lead}\n\n${fieldTable(r.fields, from)}` : lead;
}

/** A table of a field's values as a `###` under its object, its cells' pipes escaped. */
function tableMarkdown(t: ReferenceTable): string {
  const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [
    `### ${t.title}`,
    t.description,
    [row(t.columns), row(t.columns.map(() => "---")), ...t.rows.map(row)].join("\n"),
  ].join("\n\n");
}

/** One object as a Markdown section, first under its resource: its description, fields, its
 *  tables, and example. */
function objectMarkdown(o: ReferenceObject): string {
  return [
    `## ${o.title}`,
    o.description,
    fieldTable(o.fields, o.resource),
    ...(o.tables ?? []).map(tableMarkdown),
    jsonBlock("Example", o.example),
  ].join("\n\n");
}

/** Every status the API answers, with its name and what it means. */
function statusesMarkdown(statuses: ReferenceResponse["statuses"]): string {
  const rows = statuses.map((s) => `| ${s.status} | ${s.name} | ${cell(s.meaning)} |`);
  return ["| Status | Name | Meaning |", "| --- | --- | --- |", ...rows].join("\n");
}

/** The refusals any route can give, each with what it means and the client's next move; every
 *  other code is on the routes that give it. */
function sharedMarkdown(ref: ReferenceResponse): string {
  const rows = sharedRefusals(ref).map(
    (c) => `| ${c.status} \`${c.code}\` | ${cell(c.meaning)} | ${c.move} |`,
  );
  return [
    "Refusals any route can give (a route lists the rest of its own, each with what to do next):",
    ["| Refusal | Meaning | Next move |", "| --- | --- | --- |", ...rows].join("\n"),
  ].join("\n\n");
}

/** The width a JSON example keeps an object or array on one line within. */
const JSON_LINE = 80;

/** A JSON value on one line, spaced as a person would write it. */
function oneLine(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(oneLine).join(", ")}]`;
  }
  const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

/**
 * JSON indented two spaces a level, except that an object or array that fits on one line
 * stays on it: an example reads the same, in far fewer lines.
 */
export function compactJson(value: unknown, indent = "", lead = 0): string {
  const flat = oneLine(value);
  if (value === null || typeof value !== "object") {
    return flat;
  }
  // `lead` is what precedes the value on its first line (an object's key), which it must fit beside.
  if (indent.length + lead + flat.length <= JSON_LINE) {
    return flat;
  }
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => `${inner}${compactJson(v, inner)}`)
    : Object.entries(value).map(([k, v]) => {
        const key = `${JSON.stringify(k)}: `;
        return `${inner}${key}${compactJson(v, inner, key.length)}`;
      });
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${indent}${close}`;
}

/** A JSON value as a fenced block, for an example. */
function jsonBlock(label: string, value: unknown): string {
  return `${label}:\n\n\`\`\`json\n${compactJson(value)}\n\`\`\``;
}

/** Text for a Markdown table cell, whose pipes would otherwise split it. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** What a route's call line says of its tier: nothing for the admin tier, whose authentication
 *  the index describes, and how the others differ. */
const TIER_NOTE: Record<Access, string> = {
  admin: "",
  public: " (public: no authentication)",
  webhook: " (webhook: the provider signs it; not for clients to call)",
};

/** One route as a Markdown section: its title as the heading, its method and path beneath,
 *  then the summary, description, body types, query parameters, body fields, what it
 *  returns, its own refusals, and example. */
function routeMarkdown(r: ReferenceEntry): string {
  // A route off the admin tier says so on its call line, since its authentication differs.
  const tier = TIER_NOTE[r.access];
  const parts = [`## ${r.title}`, `\`${r.method} ${r.path}\`${tier}`, r.summary];
  if (r.description) {
    parts.push(r.description);
  }
  // A body is JSON unless the route says otherwise (the rules say so once).
  if (r.accepts?.length && !(r.accepts.length === 1 && r.accepts[0] === "application/json")) {
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
  if (r.returns) {
    parts.push(returnsMarkdown(r.returns, r.resource));
  }
  if (r.errors?.length) {
    // One line each: when the route gives it (or the code's own meaning), then what to do next.
    const lines = r.errors.map(
      (e) =>
        `- ${e.status} \`${e.code}\`${e.details?.length ? `, with ${e.details.map((d) => `\`${d}\``).join(", ")}` : ""}: ${e.when ?? REFUSAL_MEANING[e.code as RefusalCode]} Next move: ${e.move}.`,
    );
    parts.push(["Refusals:", ...lines].join("\n"));
  }
  if (r.example?.request !== undefined) {
    parts.push(jsonBlock("Example request", r.example.request));
  }
  if (r.example?.response !== undefined) {
    parts.push(jsonBlock("Example response", r.example.response));
  }
  return parts.join("\n\n");
}

/** The route an agent reads one resource's reference at. */
export function resourcePath(key: Resource): string {
  return `/api/reference/${key}.md`;
}

/**
 * The reference's index as Markdown, what an agent reads first (SPEC §11): the topics every
 * route shares (authentication, requests, errors with the statuses and the refusals any route
 * can give, paging, acting safely,
 * following changes), a `##` each, then a `##` per tier and a `###` per resource, listing
 * each route on one line with the resource's own document to read before calling one. A
 * resource with routes in two tiers is listed once, under the first. A
 * projection of the same response `buildReferenceResponse` returns, so it can't drift from
 * the JSON. `origin` is the base URL the paths hang off.
 */
export function referenceIndexMarkdown(ref: ReferenceResponse, origin: string): string {
  const head = `# API reference\n\nEvery route this instance serves, read from its running code, so it is complete and matches this version. Base URL \`${origin}\`. Read the topics below first; they hold what every route shares. Each resource's routes are listed on one line each: before calling one, read the resource's own reference, which describes the object its routes return and, for each route, its parameters, body, answer, refusals, and an example. The same reference as an OpenAPI 3.1 document, for tooling to import, is at \`GET /api/openapi.json\`.`;
  const concepts = ref.concepts.map((c) =>
    [
      `## ${c.title}`,
      c.text,
      ...(c.fields?.length ? [fieldTable(c.fields)] : []),
      ...(c.key === "errors" ? [statusesMarkdown(ref.statuses), sharedMarkdown(ref)] : []),
    ].join("\n\n"),
  );
  // A resource is listed once, under the first tier that has it, with every route that acts
  // on it: one off that tier says so on its line, as its own document's call line does.
  const all = ref.groups.flatMap((g) => g.routes);
  const listed = new Set<Resource>();
  const tiers = ref.groups.flatMap((g) => {
    const fresh = g.resources.filter((res) => !listed.has(res.key));
    for (const res of fresh) {
      listed.add(res.key);
    }
    if (!fresh.length) {
      return [];
    }
    const resources = fresh.map((res) => {
      const routes = [
        ...g.routes.filter((r) => r.resource === res.key),
        ...all.filter((r) => r.resource === res.key && r.access !== g.access),
      ];
      const lines = routes.map(
        (r) =>
          `- ${r.title}: \`${r.method} ${r.path}\`${r.access === g.access ? "" : TIER_NOTE[r.access]}`,
      );
      return [
        `### ${res.title}`,
        `Reference: \`GET ${resourcePath(res.key)}\``,
        lines.join("\n"),
      ].join("\n\n");
    });
    return [[`## ${g.title}`, g.blurb, ...resources].join("\n\n")];
  });
  return `${[head, ...concepts, ...tiers].join("\n\n")}\n`;
}

/**
 * One resource's reference as Markdown, or null when no route acts on it: the object its routes
 * return first, as Stripe puts "The Customer object" first under Customers, then each route in
 * full, a `##` each, each refusal with what it means and the next move; one any route can
 * give is in the index, under Errors, and an object
 * another resource heads is linked in that resource's document.
 */
export function resourceMarkdown(ref: ReferenceResponse, key: string): string | null {
  const routes = ref.groups.flatMap((g) => g.routes).filter((r) => r.resource === key);
  const title = ref.groups.flatMap((g) => g.resources).find((res) => res.key === key)?.title;
  if (!routes.length || title === undefined) {
    return null;
  }
  const objects = ref.objects.filter((o) => o.resource === key);
  const head = `# ${title}\n\nPart of the API reference; [the index](../reference.md) holds what every route shares, the refusals any route can give among it.`;
  return `${[head, ...objects.map(objectMarkdown), ...routes.map(routeMarkdown)].join("\n\n")}\n`;
}
