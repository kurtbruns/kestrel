import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import apiDoc from "../docs/API.md";
import { type ReferenceResponse, routeAnchor } from "../shared/reference";
import { refusalAdvice } from "../shared/sends";
import {
  ERASED_MARKER_MEANING,
  FLAG_MEANING,
  STATUS_MEANING,
  SUBSCRIBER_ACTIONS,
  SUPPRESSED_MEANING,
} from "../shared/subscriber_meanings";
import { createRouter } from "../src/app";
import { requireAuth } from "../src/auth/middleware";
import { type AppEnv, getConfig } from "../src/env";
import {
  buildReference,
  buildReferenceResponse,
  referenceIndexMarkdown,
  resourceMarkdown,
} from "../src/reference";
import { OBJECTS } from "../src/reference/objects";
import { REFUSAL_STATUS, refusalGroups } from "../src/reference/refusals";
import { type RouteDef, Router } from "../src/router";
import { AUTH, base } from "./support/http";

// The point of the manifest: the reference IS the registration. These tests pin
// that it can't drift — every live route is listed, its documented tier is the
// tier that actually gates it, and a newly registered route shows up for free.

// The Worker's source and the shared modules, as text: where a refusal code is thrown or answered.
const GIVING_SOURCES = {
  ...import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../shared/*.ts", { query: "?raw", import: "default", eager: true }),
};

/** Source text with its comments removed, since a code named in a comment is never given. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every resource's own reference, by its key, as `/api/reference/<key>.md` serves it. */
function resourceDocs(ref: ReferenceResponse): Map<string, string> {
  const keys = new Set(ref.groups.flatMap((g) => g.resources.map((res) => res.key)));
  return new Map([...keys].map((key) => [key, resourceMarkdown(ref, key) ?? ""]));
}

describe("API reference is generated from the route registration", () => {
  const router = createRouter(getConfig(env as AppEnv));
  const defs = router.routes.map((r) => r.def);

  it("lists every registered route, each tagged with its own tier", () => {
    const groups = buildReference(defs);
    const listed = groups.flatMap((g) =>
      g.routes.map((r) => ({ key: `${r.method} ${r.path}`, access: r.access })),
    );
    // Same routes as the router, no more and no fewer.
    expect(new Set(listed.map((l) => l.key))).toEqual(
      new Set(defs.map((d) => `${d.method} ${d.path}`)),
    );
    expect(listed.length).toBe(defs.length);
    // Every route lands in the group matching its declared access.
    for (const g of groups) {
      for (const r of g.routes) {
        expect(r.access).toBe(g.access);
      }
    }
  });

  it("describes each object by the fields its example carries, no more and no fewer", () => {
    // Each example satisfies its wire type in shared/ (src/reference/objects.ts), so the
    // compiler holds the example to the wire; this holds the described fields to the example.
    // A field's name before its first dot is the object's own field, and one row may name two
    // fields that share a line ("confirm_token, unsub_token").
    const notInExample: Partial<Record<keyof typeof OBJECTS, string[]>> = {
      // The example is one revision's read, with its body; the history's rows carry
      // `is_current` in its place.
      revision: ["is_current"],
    };
    for (const [key, o] of Object.entries(OBJECTS)) {
      const described = new Set(
        o.fields.flatMap((f) => f.name.split(", ").map((name) => name.split(".")[0])),
      );
      const shown = [
        ...Object.keys(o.example as object),
        ...(notInExample[key as keyof typeof OBJECTS] ?? []),
      ];
      expect([...described].sort(), key).toEqual(shown.sort());
    }
  });

  it("states a halted send's retry schedule as the sweep keeps it (SPEC §12)", () => {
    const halt = OBJECTS.send.fields.find((f) => f.name === "provider.halt")!;
    const said = JSON.stringify(halt);
    expect(said).toContain("retried after 1, 2, 5, 15, and 30 minutes and then every 60 minutes");
    expect(said).toContain("retried after 5, 15, and 30 minutes and then every 60 minutes");
    expect(said).toContain("retry_at");
  });

  it("every route under the re-make rule states it in its own description (the reference is what Claude reads)", () => {
    // SPEC §9: a template or identity change re-makes the scheduled sends after an
    // explicit acknowledgement. The generated reference is where a client learns that
    // before calling, so the rule lives on the route, not in a document beside it.
    const byKey = new Map(defs.map((d) => [`${d.method} ${d.path}`, d]));
    for (const key of [
      "PUT /api/settings",
      "POST /api/settings/logo",
      "DELETE /api/settings/logo",
    ]) {
      expect(byKey.get(key)?.description ?? "").toMatch(/re-make/);
      expect(byKey.get(key)?.description ?? "").toMatch(/remake/);
    }
    expect(byKey.get("GET /api/settings")?.summary ?? "").toMatch(/inUse/);
    // SPEC §5: once scheduled, the test and preview are the frozen copy.
    for (const key of [
      "POST /api/posts/:id/preview",
      "GET /api/posts/:id/preview",
      "POST /api/posts/:id/test",
    ]) {
      expect(byKey.get(key)?.description ?? "").toMatch(/frozen copy/);
    }
  });

  it("tells a client what each subscriber status, suppression, and act means, in the editor legend's words (SPEC §7)", () => {
    const byKey = new Map(defs.map((d) => [`${d.method} ${d.path}`, d]));
    const describe = (key: string) => byKey.get(key)?.description ?? "";
    // Each object says it once: the subscriber's statuses and suppression, the suppression's reasons.
    const said = (key: "subscriber" | "suppression") => JSON.stringify(OBJECTS[key]);
    for (const key of ["subscriber", "suppression"] as const) {
      expect(said(key)).toContain(SUPPRESSED_MEANING);
    }
    // The reasons' meanings are said once, under the suppression, each flag's once.
    for (const [flag, meaning] of Object.entries(FLAG_MEANING)) {
      if (flag !== "erased") {
        expect(said("suppression").split(meaning).length - 1).toBe(1);
        expect(said("subscriber")).not.toContain(meaning);
      }
    }
    // The roster shows an erasure's marker only on someone who signed up again; the list of
    // suppressions holds markers with no subscriber, so it says what a marker is instead.
    expect(said("subscriber")).toContain(FLAG_MEANING.erased);
    expect(said("suppression")).toContain(ERASED_MARKER_MEANING);
    expect(said("suppression")).not.toContain(FLAG_MEANING.erased);
    for (const meaning of Object.values(STATUS_MEANING)) {
      expect(said("subscriber")).toContain(meaning);
    }
    // Each act says when it is the one to use, and so whose decision it records.
    expect(describe("POST /api/subscribers/:id/unsubscribe")).toContain(
      SUBSCRIBER_ACTIONS.unsubscribe.when,
    );
    expect(describe("POST /api/suppressions")).toContain(SUBSCRIBER_ACTIONS.block.when);
    expect(describe("POST /api/subscribers/:id/erase")).toContain(SUBSCRIBER_ACTIONS.erase.when);
    expect(describe("DELETE /api/suppressions/:email")).toContain(SUBSCRIBER_ACTIONS.clear.when);
    expect(byKey.get("DELETE /api/suppressions/:email")?.errors?.map((e) => e.code)).toEqual([
      "erasure_marker",
    ]);
  });

  it("groups admin, public, and webhook tiers (mirroring app.ts)", () => {
    const groups = buildReference(defs);
    expect(groups.map((g) => g.access)).toEqual(["admin", "public", "webhook"]);
  });

  it("groups each tier by the resource every route declares, publication work first", () => {
    const groups = buildReference(defs);
    const admin = groups.find((g) => g.access === "admin");
    expect(admin?.resources.map((res) => res.key)).toEqual([
      "posts",
      "sends",
      "subscribers",
      "imports",
      "suppressions",
      "settings",
      "system",
      "dev",
    ]);
    expect(admin?.resources.find((res) => res.key === "posts")?.title).toBe("Posts");
    // Each route carries the resource it declared, and a tier's routes run resource by
    // resource in the order its resources are listed.
    const declared = new Map(defs.map((d) => [`${d.method} ${d.path}`, d.resource]));
    for (const g of groups) {
      for (const r of g.routes) {
        expect(r.resource).toBe(declared.get(`${r.method} ${r.path}`));
      }
      const runs = g.routes.map((r) => r.resource).filter((k, i, all) => k !== all[i - 1]);
      expect(runs).toEqual(g.resources.map((res) => res.key));
    }
  });

  it("documents the declared tier as the tier that actually gates the route", () => {
    // `access` DRIVES the gate: admin ⇒ requireAuth present; public/webhook ⇒ absent.
    for (const route of router.routes) {
      expect(route.middleware.includes(requireAuth)).toBe(route.def.access === "admin");
    }
  });

  it("is self-describing: the reference endpoint appears in its own listing", () => {
    expect(defs.some((d) => d.method === "GET" && d.path === "/api/reference")).toBe(true);
  });

  it("gives every route its own address in the editor's reference", () => {
    // The anchor is a page's element id and a link someone shares, so two routes can't share
    // one, and none can take the address of a part of the page (a topic, a tier, a resource,
    // an object), which the page would otherwise open instead.
    const anchors = defs.map((d) => routeAnchor(d));
    expect(new Set(anchors).size).toBe(defs.length);
    const parts = /^(overview|objects|admin|public|webhook)(-|$)/;
    expect(anchors.filter((a) => parts.test(a))).toEqual([]);
    expect(routeAnchor({ title: "Cancel a send" })).toBe("cancel-send");
    expect(routeAnchor({ title: "List a post's revisions" })).toBe("list-post-revisions");
    expect(routeAnchor({ title: "Get the API reference's index" })).toBe("get-api-reference-index");
  });

  it("names every route by what it does, each name its own (the reference leads with it)", () => {
    const groups = buildReference(defs);
    const titles = groups.flatMap((g) => g.routes.map((r) => r.title));
    expect(titles.length).toBe(defs.length);
    // A short act, capitalized, with no trailing period and no path in it.
    for (const t of titles) {
      expect(t).toMatch(/^[A-Z][^/.]{2,40}$/);
    }
    // Two routes under one name would leave the reader to tell them apart by path again.
    expect(new Set(titles).size).toBe(titles.length);
    expect(
      groups.flatMap((g) => g.routes).find((r) => r.path === "/api/posts/:id/schedule")?.title,
    ).toBe("Schedule a post");
  });

  it("carries documented query params through for list routes (filter/sort/pagination)", () => {
    const groups = buildReference(defs);
    const listRoute = groups
      .flatMap((g) => g.routes)
      .find((r) => r.method === "GET" && r.path === "/api/subscribers");
    const names = listRoute?.query?.map((q) => q.name) ?? [];
    // The list contract — filter + sort + pagination — is documented from the registration.
    expect(names).toEqual(
      expect.arrayContaining(["status", "suppressed", "sort", "limit", "offset"]),
    );
  });

  it("documents the fields of every route that takes a body, and of none that takes none", () => {
    for (const d of defs) {
      const key = `${d.method} ${d.path}`;
      // A route that declares a body type says what goes in it, a form upload's file included.
      expect((d.body?.length ?? 0) > 0, key).toBe((d.accepts?.length ?? 0) > 0);
      const names = (d.body ?? []).map((f) => f.name);
      expect(new Set(names).size, key).toBe(names.length);
    }
    const byKey = new Map(defs.map((d) => [`${d.method} ${d.path}`, d]));
    // The fields a client most needs and could only guess before: Resolve's choice, and every
    // group a settings save takes, named by the dotted path a 400 names it by.
    expect(byKey.get("POST /api/sends/:id/resolve")?.body).toEqual([
      expect.objectContaining({
        name: "resolution",
        type: '"unsent" | "accepted"',
        required: true,
      }),
    ]);
    expect(byKey.get("PUT /api/settings")?.body?.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "testRecipients",
        "publication.name",
        "emailTemplate",
        "confirmationEmail.subject",
        "notifications.to",
        "remake",
      ]),
    );
    expect(byKey.get("POST /api/settings/logo")?.body).toEqual([
      expect.objectContaining({ name: "file", type: "file", required: true }),
    ]);
  });

  it("lists the refusals each route gives of its own, with the status its code carries", () => {
    // Each route that refuses with a state of its own declares it, so a client can expect the
    // refusal rather than read it as a failure. A route's codes are typed against the registry
    // (src/reference/refusals.ts), as is every code src/ throws, so which route lists which
    // code is the manifest's to say; this pins the rules that run across routes.
    const listed = new Map(
      buildReference(defs)
        .flatMap((g) => g.routes)
        .map((r) => [`${r.method} ${r.path}`, r.errors ?? []]),
    );
    // Every route under the re-make rule (SPEC §9) gives its refusals.
    for (const key of [
      "PUT /api/settings",
      "POST /api/settings/logo",
      "DELETE /api/settings/logo",
    ]) {
      expect(
        listed.get(key)?.map((e) => e.code),
        key,
      ).toEqual(["remake_required", "remake_too_close", "conflict"]);
    }
    // Every route that would send says it is refused while no provider is connected.
    for (const key of [
      "POST /api/posts/:id/send",
      "POST /api/posts/:id/test",
      "POST /api/settings/template/test",
    ]) {
      expect(
        listed.get(key)?.map((e) => e.code),
        key,
      ).toContain("provider_not_connected");
    }
    for (const errors of listed.values()) {
      for (const e of errors) {
        expect(e.status).toBe(REFUSAL_STATUS[e.code as keyof typeof REFUSAL_STATUS]);
      }
      // A code once per route: two lines for one code would leave the client to choose.
      expect(new Set(errors.map((e) => e.code)).size).toBe(errors.length);
    }
    expect(listed.get("POST /api/sends/:id/resolve")?.[1]).toEqual(
      expect.objectContaining({ status: 409, code: "not_wedged", details: ["send"] }),
    );
  });

  it("documents every code the API refuses with on a route, or among those every route shares", () => {
    // The compiler holds every code thrown to the registry; this holds the registry to the
    // routes. A code no route lists is one the index states once for every route (its Errors
    // topic) or a fault of the deployment's; any other is a refusal no client could expect.
    const shared = [
      "unsupported_media_type",
      "internal_error",
      "settings_corrupt",
      "unauthorized",
      "forbidden",
      "cross_site_request",
    ];
    const onRoutes = new Set<string>(defs.flatMap((d) => (d.errors ?? []).map((e) => e.code)));
    const unlisted = Object.keys(REFUSAL_STATUS).filter((code) => !onRoutes.has(code));
    expect(unlisted.sort()).toEqual([...shared].sort());
    // And every code is one the API gives: named outside the manifest and the reference, where
    // something throws or answers with it, so the reference can't keep a code nothing gives.
    const elsewhere = Object.entries(GIVING_SOURCES)
      .filter(([file]) => !file.startsWith("../src/reference/") && file !== "../src/app.ts")
      .map(([, text]) => withoutComments(text as string))
      .join("\n");
    for (const code of Object.keys(REFUSAL_STATUS)) {
      expect(elsewhere.includes(`"${code}"`), code).toBe(true);
    }
  });

  it("knows the same refusal codes as docs/API.md's Refusing section, so neither drifts from the other", () => {
    const section = apiDoc.slice(
      apiDoc.indexOf("## Refusing"),
      apiDoc.indexOf("## Adding to the API"),
    );
    // Every backticked code in the section, less the fields and values it names beside them.
    const notCodes = new Set([
      "error",
      "message",
      "field",
      "retry_after",
      "send",
      "sends",
      "attestation",
      "row",
      "column",
      "allowed",
      "limit",
      "variable",
      "missing",
      "reason",
      "erased_at",
      "acknowledge_erasure",
      "markdown",
    ]);
    const named = new Set(
      [...section.matchAll(/`([a-z][a-z_]+)`/g)]
        .map(([, code]) => code as string)
        .filter((code) => !notCodes.has(code)),
    );
    expect([...named].sort()).toEqual(Object.keys(REFUSAL_STATUS).sort());
    // Each code in one group only: a code listed under two moves would merge into one silently.
    const grouped = refusalGroups().flatMap((g) => g.codes.map((c) => c.code));
    expect(grouped.length).toBe(Object.keys(REFUSAL_STATUS).length);
  });

  it("describes every object a route returns, once, first under its resource, and links each route to it", () => {
    const ref = buildReferenceResponse(defs);
    const docs = resourceDocs(ref);
    const all = [...docs.values()].join("\n");
    const returned = ref.groups.flatMap((g) => g.routes).flatMap((r) => r.returns?.object ?? []);
    expect(new Set(returned)).toEqual(new Set(ref.objects.map((o) => o.key)));
    for (const o of ref.objects) {
      expect(all.match(new RegExp(`^## ${o.title}$`, "gm")), o.key).toHaveLength(1);
      expect(docs.get(o.resource), o.key).toMatch(new RegExp(`^## ${o.title}$`, "m"));
    }
    // Stripe's order: the object heads its resource, before the routes that return it.
    expect(docs.get("sends")).toMatch(/^# Sends\n\n[^\n]+\n\n## The send view\n/);
    expect(docs.get("posts")).toMatch(/^## The post object$[\s\S]*?^## The revision object$/m);
    // A link to an object is to its own section, in another resource's document when it heads one.
    expect(docs.get("sends")).toContain("[The send view](#the-send-view)");
    expect(docs.get("posts")).toContain("[The send view](sends.md#the-send-view)");
    const byKey = new Map(
      ref.groups.flatMap((g) => g.routes).map((r) => [`${r.method} ${r.path}`, r]),
    );
    expect(byKey.get("POST /api/sends/:id/cancel")?.returns).toEqual({
      object: "send",
      as: "send",
      fields: [
        expect.objectContaining({ name: "cursor" }),
        expect.objectContaining({ name: "changed" }),
      ],
    });
  });

  it("states what every send shares once: the conditions, the halts, and the whole send view's example", () => {
    const ref = buildReferenceResponse(defs);
    const index = referenceIndexMarkdown(ref, "https://newsletter.example.com");
    const all = [index, ...resourceDocs(ref).values()].join("\n");
    // A line from the conditions glossary, a line from the halts, and a field only the full
    // example carries: each once, in the send view, where route prose used to repeat them.
    expect(all.match(/recipient handed off for 30 minutes/g)).toHaveLength(1);
    expect(all.match(/retried after 1, 2, 5, 15, and 30 minutes/g)).toHaveLength(1);
    expect(all.match(/"deliveries_csv":/g)).toHaveLength(1);
    // The index leads with the topics, in plain sentences, the refusal table under Errors.
    expect([...index.matchAll(/^## (.+)$/gm)].map(([, t]) => t).slice(0, 6)).toEqual([
      "Authentication",
      "Requests",
      "Errors",
      "Lists and paging",
      "Acting safely",
      "Following changes",
    ]);
    expect(all).not.toContain("**");
    expect(index).toMatch(
      /^## Errors\n[\s\S]*?\| Next move \| Refusal \| Meaning \|[\s\S]*?^## Lists and paging$/m,
    );
    expect(index).toContain("| Read again, then decide | 409 `stale_revision` |");
  });

  it("shows each answer's send at the change its cursor stands at, as the server answers", () => {
    // An answer's cursor is the change sequence at its read, and the send in it is as of that
    // read: an act's answer carries the send its act just changed, so its rev is the cursor's.
    let checked = 0;
    for (const d of defs) {
      const res = d.example?.response as { send?: { rev?: number }; cursor?: string } | undefined;
      if (res?.send?.rev !== undefined && res.cursor !== undefined) {
        expect(res.send.rev, `${d.method} ${d.path}`).toBe(Number(res.cursor.split(".")[0]));
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("a newly registered route appears in the reference with no separate doc to touch", () => {
    const r = new Router();
    const added: RouteDef = {
      method: "POST",
      path: "/demo/thing",
      access: "admin",
      resource: "posts",
      title: "Make a thing",
      summary: "A freshly registered admin route.",
      handler: () => new Response("ok"),
    };
    r.register(added);
    r.register({
      method: "GET",
      path: "/demo/public",
      access: "public",
      resource: "archive",
      title: "Show a thing",
      summary: "A freshly registered public route.",
      handler: () => new Response("ok"),
    });
    const groups = buildReference(r.routes.map((x) => x.def));
    const admin = groups.find((g) => g.access === "admin");
    const pub = groups.find((g) => g.access === "public");
    expect(admin?.routes.some((x) => x.path === "/demo/thing")).toBe(true);
    expect(pub?.routes.some((x) => x.path === "/demo/public")).toBe(true);
    // And the declared admin tier is backed by the real gate.
    const addedRoute = r.routes.find((x) => x.def.path === "/demo/thing");
    expect(addedRoute?.middleware.includes(requireAuth)).toBe(true);
  });
});

describe("/api/reference is served like the rest of the authed admin surface", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch(`${base}/api/reference`);
    expect(res.status).toBe(401);
  });

  it("returns the manifest as JSON when authed, listing real routes (the SPA renders it)", async () => {
    const res = await SELF.fetch(`${base}/api/reference`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      groups: { access: string; routes: { method: string; path: string; access: string }[] }[];
    };
    const routes = body.groups.flatMap((g) => g.routes);
    // Real routes + methods + tiers survive to the payload.
    expect(routes.some((r) => r.path === "/api/posts")).toBe(true);
    expect(routes.some((r) => r.path === "/webhooks/ses" && r.access === "webhook")).toBe(true);
    expect(routes.some((r) => r.method === "POST")).toBe(true);
    // A hand-authored example made it through (the create-post request body).
    expect(JSON.stringify(body)).toContain("Hello, world");
  });
});

describe("the reference as Markdown, for an agent (/api/reference.md)", () => {
  const router = createRouter(getConfig(env as AppEnv));
  const defs = router.routes.map((r) => r.def);

  it("lists every route on one line in the index, under its tier and resource, with the resource's own reference", () => {
    const md = referenceIndexMarkdown(
      buildReferenceResponse(defs),
      "https://newsletter.example.com",
    );
    // A route off its resource's tier carries its tier's note after the path.
    const lines = [...md.matchAll(/^- (.+): `(\S+) (\S+)`(?: \(.+\))?$/gm)].map(
      ([, t, m, p]) => `${t}: ${m} ${p}`,
    );
    expect(lines.sort()).toEqual(defs.map((d) => `${d.title}: ${d.method} ${d.path}`).sort());
    expect(md).toContain("Base URL `https://newsletter.example.com`");
    expect(md).toMatch(
      /^## Admin\n\n[^#][\s\S]*?^### Posts\n\nReference: `GET \/api\/reference\/posts\.md`\n\n- /m,
    );
    // A resource with routes in two tiers is listed once, under the first, its other routes
    // marked: health is a public route among the admin tier's System.
    const headings = [...md.matchAll(/^### (.+)$/gm)].map(([, h]) => h);
    expect(headings.length).toBe(new Set(headings).size);
    expect(md).toMatch(
      /^### System\n[\s\S]*?^- Check health: `GET \/health` \(public: no authentication\)$/m,
    );
    expect(md).not.toContain("## Webhooks");
    // The index carries no route's detail: that is the resource's own reference.
    expect(md).not.toContain("| Body field |");
    expect(md).not.toContain("Example response:");
  });

  it("gives every route its own section in its resource's reference: call, parameters, body, answer, refusals, example", () => {
    const ref = buildReferenceResponse(defs);
    const docs = resourceDocs(ref);
    for (const d of defs) {
      expect(docs.get(d.resource), `${d.method} ${d.path}`).toContain(
        `\n## ${d.title}\n\n\`${d.method} ${d.path}\``,
      );
    }
    const sends = docs.get("sends") ?? "";
    expect(docs.get("posts")).toMatch(/\| Query parameter \| Description \|/);
    expect(sends).toContain(
      '| Body field | Type | Description |\n| --- | --- | --- |\n| `resolution` (required) | "unsent" \\| "accepted" |',
    );
    expect(sends).toContain(
      "Refusals:\n- 409 `run_in_progress`, with `send`: A run holds the send, and its in-flight rows may still get the provider's answer: try again a moment later.\n- 409 `not_wedged`, with `send`: ",
    );
    expect(sends).toContain("Example response:");
    // A route off the admin tier says so on its call line.
    expect(docs.get("subscriptions")).toContain("`POST /subscribe` (public: no authentication)");
    expect(sends).toContain("`POST /webhooks/ses` (webhook: the provider signs it");
    // The refusals every route shares are said once, in the index, never in a route's own.
    for (const doc of docs.values()) {
      expect(doc).not.toContain("`unauthorized`");
    }
    expect(resourceMarkdown(ref, "nothing")).toBeNull();
  });

  it("tables each condition kind and halt cause under the send view, with its remedy (SPEC §8, §12)", () => {
    const sends = resourceMarkdown(buildReferenceResponse(defs), "sends") ?? "";
    const table = (title: string) =>
      sends.split(`\n### ${title}\n`)[1]?.split("\n\n")[1]?.split("\n").slice(2) ?? [];
    const kinds = table("Condition kinds").map((row) => row.split(" | ")[0]);
    expect(kinds).toEqual(
      [
        "missed",
        "stuck",
        "wedged",
        "refused",
        "provider_unavailable",
        "bounce_spike",
        "no_receipts",
        "remade",
        "untested",
        "daily_writes",
      ].map((k) => `| \`${k}\``),
    );
    expect(sends).toContain("| `missed` | `action` | none |");
    expect(sends).toContain("checks the Worker's Cron Trigger (`triggers.crons`)");
    // An account cause's fix is the advice its condition carries, word for word.
    expect(table("Halt causes")).toContain(
      `| \`sandbox\` | \`account\` | ${refusalAdvice("sandbox")} |`,
    );
    expect(table("Halt causes")).toHaveLength(17);
  });

  it("is served as text/markdown when authed: the index, and each resource's reference", async () => {
    const res = await SELF.fetch(`${base}/api/reference.md`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const index = await res.text();
    expect(index).toMatch(/^# API reference/);
    expect(index).toContain("- Get a doc as Markdown: `GET /api/docs/:name.md`\n");
    expect(index).toContain(`Base URL \`${base}\``);
    const sends = await SELF.fetch(`${base}/api/reference/sends.md`, { headers: AUTH });
    expect(sends.status).toBe(200);
    expect(sends.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await sends.text()).toMatch(/^# Sends\n/);
    const unknown = await SELF.fetch(`${base}/api/reference/nothing.md`, { headers: AUTH });
    expect(unknown.status).toBe(404);
    expect((await SELF.fetch(`${base}/api/reference/sends.md`)).status).toBe(401);
  });

  it("keeps the index, what an agent reads first, a fraction of the whole reference", () => {
    // Every conversation reads the index up front; a resource's reference is read when the work
    // reaches it. If the index grows toward the whole, route detail has leaked into it.
    const ref = buildReferenceResponse(defs);
    const index = referenceIndexMarkdown(ref, "https://newsletter.example.com").length;
    const whole = index + [...resourceDocs(ref).values()].join("").length;
    expect(index / whole).toBeLessThan(0.3);
  });
});
