import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import apiDoc from "../docs/API.md";
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
import { buildReference, buildReferenceResponse, referenceMarkdown } from "../src/reference";
import { OBJECTS } from "../src/reference/objects";
import { REFUSAL_STATUS, refusalGroups } from "../src/reference/refusals";
import { type RouteDef, Router } from "../src/router";
import { AUTH, base } from "./support/http";

// The point of the manifest: the reference IS the registration. These tests pin
// that it can't drift — every live route is listed, its documented tier is the
// tier that actually gates it, and a newly registered route shows up for free.

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
      for (const [flag, meaning] of Object.entries(FLAG_MEANING)) {
        if (flag !== "erased") {
          expect(said(key)).toContain(meaning);
        }
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
    // refusal rather than read it as a failure.
    const expected: Record<string, string[]> = {
      "PUT /api/settings": ["remake_required", "remake_too_close", "conflict"],
      "POST /api/settings/logo": ["remake_required", "remake_too_close", "conflict"],
      "DELETE /api/settings/logo": ["remake_required", "remake_too_close", "conflict"],
      "POST /api/posts": ["slug_invalid", "slug_taken"],
      "PUT /api/posts/:id": [
        "base_required",
        "stale_revision",
        "post_not_draft",
        "slug_invalid",
        "slug_taken",
      ],
      "DELETE /api/posts/:id": ["post_not_draft"],
      "PUT /api/posts/:id/settings": ["slug_invalid", "slug_taken", "slug_permanent"],
      "POST /api/posts/:id/images": ["post_not_draft"],
      "DELETE /api/posts/:id/images/:filename": ["post_not_draft"],
      "POST /api/posts/:id/schedule": [
        "fire_at_too_soon",
        "active_send_exists",
        "post_not_draft",
        "subject_required",
        "settings_changed",
        "provider_not_connected",
        "slug_invalid",
        "slug_taken",
      ],
      "GET /api/sends/feed": ["cursor_ahead"],
      "POST /api/sends/:id/cancel": ["window_closed"],
      "POST /api/sends/:id/reschedule": ["fire_at_too_soon", "window_closed", "send_canceled"],
      "POST /api/sends/:id/resolve": ["run_in_progress", "not_wedged"],
      "POST /api/subscribers": [
        "erasure_acknowledgement_required",
        "provider_not_connected",
        "confirmation_not_sent",
      ],
      "POST /api/subscribers/:id/erase": ["run_in_progress"],
      "POST /api/imports": [
        "plan_stale",
        "attestation_required",
        "sends_acknowledgement_required",
        "unrecognized_format",
        "invalid_field",
        "too_many_rows",
        "body_too_large",
      ],
      "DELETE /api/suppressions/:email": ["erasure_marker"],
      "POST /subscribe": ["provider_not_connected"],
    };
    const listed = new Map(
      buildReference(defs)
        .flatMap((g) => g.routes)
        .map((r) => [`${r.method} ${r.path}`, r.errors ?? []]),
    );
    for (const [key, codes] of Object.entries(expected)) {
      expect(
        listed.get(key)?.map((e) => e.code),
        key,
      ).toEqual(codes);
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
    const md = referenceMarkdown(ref, "https://newsletter.example.com");
    const returned = ref.groups.flatMap((g) => g.routes).flatMap((r) => r.returns?.object ?? []);
    expect(new Set(returned)).toEqual(new Set(ref.objects.map((o) => o.key)));
    for (const o of ref.objects) {
      expect(md.match(new RegExp(`^#### ${o.title}$`, "gm")), o.key).toHaveLength(1);
      expect(md).toContain(`](#${o.title.toLowerCase().replaceAll(" ", "-")})`);
    }
    // Stripe's order: the object heads its resource, before the routes that return it.
    expect(md).toMatch(/^### Sends\n\n#### The send view\n/m);
    expect(md).toMatch(/^### Posts\n\n#### The post object\n[\s\S]*?^#### The revision object$/m);
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
    const md = referenceMarkdown(buildReferenceResponse(defs), "https://newsletter.example.com");
    // A line from the conditions glossary, a line from the halts, and a field only the full
    // example carries: each once, in the send view, where route prose used to repeat them.
    expect(md.match(/recipient handed off for 30 minutes/g)).toHaveLength(1);
    expect(md.match(/retried after 1, 2, 5, 15, and 30 minutes/g)).toHaveLength(1);
    expect(md.match(/"deliveries_csv":/g)).toHaveLength(1);
    // And the topics lead, in plain sentences, the refusal table under Errors.
    expect([...md.matchAll(/^## (.+)$/gm)].map(([, t]) => t).slice(0, 5)).toEqual([
      "Authentication",
      "Errors",
      "Lists and paging",
      "Acting safely",
      "Following changes",
    ]);
    expect(md).not.toContain("**");
    expect(md).toMatch(
      /^## Errors\n[\s\S]*?\| Next move \| Refusal \| Meaning \|[\s\S]*?^## Lists and paging$/m,
    );
    expect(md).toContain("| Read again, then decide | 409 `stale_revision` |");
    expect(md.indexOf("## Following changes")).toBeLessThan(md.indexOf("## Admin"));
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

  it("gives every registered route its own heading, its title over its method and path, under its tier and resource", () => {
    const md = referenceMarkdown(buildReferenceResponse(defs), "https://newsletter.example.com");
    const headings = [...md.matchAll(/^#### (.+)\n\n`(\S+) (\S+)`$/gm)].map(
      ([, t, m, p]) => `${t}: ${m} ${p}`,
    );
    expect(headings.sort()).toEqual(defs.map((d) => `${d.title}: ${d.method} ${d.path}`).sort());
    expect(md).toContain("Base URL `https://newsletter.example.com`");
    // Tiers, then their resources, then routes, each a level down.
    expect(md).toMatch(
      /^## Admin\n\n[^#][\s\S]*?^### Posts\n\n[\s\S]*?^#### .+\n\n`\S+ \/api\/posts\S*`$/m,
    );
    expect(md).not.toMatch(/^## \S+: /m);
    // A route's query table, body table, and example come through.
    expect(md).toMatch(/\| Query parameter \| Description \|/);
    expect(md).toContain(
      '| Body field | Type | Description |\n| --- | --- | --- |\n| `resolution` (required) | "unsent" \\| "accepted" |',
    );
    expect(md).toContain(
      "Refusals:\n- 409 `run_in_progress`, with `send`: A run holds the send, and its in-flight rows may still get the provider's answer: try again a moment later.\n- 409 `not_wedged`, with `send`: ",
    );
    // The refusals every route shares are said once, at the top, never in a route's own.
    expect(md.indexOf("401 `unauthorized`")).toBeLessThan(md.indexOf("## Admin"));
    expect(md.slice(md.indexOf("## Admin"))).not.toContain("`unauthorized`");
    expect(md).toContain("Example response:");
  });

  it("is served as text/markdown when authed, matching the JSON's routes", async () => {
    const res = await SELF.fetch(`${base}/api/reference.md`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const md = await res.text();
    expect(md).toMatch(/^# API reference/);
    expect(md).toContain("\n#### Get a doc as Markdown\n\n`GET /api/docs/:name.md`\n");
    expect(md).toContain(`Base URL \`${base}\``);
  });
});
