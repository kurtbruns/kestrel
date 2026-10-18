import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ReferenceField, ReferenceResponse } from "../shared/reference";
import { createRouter } from "../src/app";
import { POST_LIST_SPEC } from "../src/db/posts";
import { DELIVERY_LIST_SPEC, SEND_LIST_SPEC } from "../src/db/sends";
import { SUBSCRIBER_LIST_SPEC } from "../src/db/subscribers";
import { type AppEnv, getConfig } from "../src/env";
import { buildReferenceResponse } from "../src/reference";

// The naming rule on the wire (docs/API.md, "Names on the wire"): every JSON field name and
// enum value is snake_case, a query parameter's value is too, and a sort key is the name of
// the field it sorts by. Claude writes a request from the reference, so each exception is a
// name it has to get right by reading closely. These walk the reference as the API serves
// it, so a name that breaks the rule fails here before it ships.

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const ref: ReferenceResponse = buildReferenceResponse(
  createRouter(getConfig(env as AppEnv)).routes.map((r) => r.def),
);

/** Every documented field, with where it is documented. */
function allFields(): { where: string; field: ReferenceField }[] {
  const out: { where: string; field: ReferenceField }[] = [];
  for (const o of ref.objects) {
    for (const field of o.fields) {
      out.push({ where: `the ${o.key} object`, field });
    }
  }
  for (const c of ref.concepts) {
    for (const field of c.fields ?? []) {
      out.push({ where: `the ${c.key} topic`, field });
    }
  }
  for (const r of ref.groups.flatMap((g) => g.routes)) {
    const where = `${r.method} ${r.path}`;
    for (const field of [...(r.body ?? []), ...(r.returns?.fields ?? [])]) {
      out.push({ where, field });
    }
  }
  return out;
}

/** Every key of a JSON value, at any depth, with its path. */
function keysOf(value: unknown, path: string, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      keysOf(v, `${path}[${i}]`, out);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(`${path}.${k}`);
      keysOf(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf(".") + 1);

describe("names on the wire are snake_case", () => {
  it("names every documented field in snake_case, each segment of a dotted path", () => {
    const bad = allFields()
      .flatMap(({ where, field }) =>
        // A row may name several fields at once (`confirm_token, unsub_token`) or elide its
        // middle (`send, post, …`); each name, and each segment of a dotted path, is checked.
        field.name
          .split(/[.,]\s*|\s+/)
          .filter((seg) => seg !== "" && seg !== "…")
          .map((seg) => ({ where, name: field.name, seg })),
      )
      // A list's items are named `sends[]`; the brackets are the reference's, not the wire's.
      .filter(({ seg }) => !SNAKE.test(seg.replace(/\[\]$/, "")))
      .map(({ where, name }) => `${where}: ${name}`);
    expect(bad).toEqual([]);
  });

  it("gives every enum value in snake_case", () => {
    const bad = allFields().flatMap(({ where, field }) =>
      (field.values ?? [])
        .filter((v) => !SNAKE.test(v.value))
        .map((v) => `${where}: ${field.name} = ${v.value}`),
    );
    expect(bad).toEqual([]);
  });

  it("names every key of every example in snake_case", () => {
    const examples: [string, unknown][] = [
      ...ref.objects.map((o): [string, unknown] => [`the ${o.key} object`, o.example]),
      ...ref.groups
        .flatMap((g) => g.routes)
        .flatMap((r): [string, unknown][] => [
          [`${r.method} ${r.path} request`, r.example?.request],
          [`${r.method} ${r.path} response`, r.example?.response],
        ]),
    ];
    const bad = examples.flatMap(([where, example]) =>
      keysOf(example, "")
        .filter((path) => !SNAKE.test(lastSegment(path)))
        .map((path) => `${where}: ${path}`),
    );
    expect(bad).toEqual([]);
  });

  it("names every query parameter in snake_case", () => {
    const bad = ref.groups
      .flatMap((g) => g.routes)
      .flatMap((r) => (r.query ?? []).map((q) => `${r.method} ${r.path}: ${q.name}`))
      .filter((s) => !SNAKE.test(s.slice(s.lastIndexOf(": ") + 2)));
    expect(bad).toEqual([]);
  });

  it("documents on each list route exactly the sort keys its list takes", () => {
    const routes = ref.groups.flatMap((g) => g.routes);
    const documented = (path: string) => {
      const sort = routes
        .find((r) => r.method === "GET" && r.path === path)
        ?.query?.find((q) => q.name === "sort");
      return new Set([...(sort?.description ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    };
    for (const [path, spec] of [
      ["/api/posts", POST_LIST_SPEC],
      ["/api/sends", SEND_LIST_SPEC],
      ["/api/subscribers", SUBSCRIBER_LIST_SPEC],
      ["/api/sends/:id/deliveries", DELIVERY_LIST_SPEC],
    ] as const) {
      expect(documented(path), path).toEqual(new Set(Object.keys(spec.columns)));
    }
  });

  it("names each sort key for the field it sorts by, a nested one by its dotted path", () => {
    const routes = ref.groups.flatMap((g) => g.routes);
    // What a list's rows carry: the object's fields, the fields the list route adds, and the
    // keys its example's rows hold (a delivery row has no object of its own).
    const rowFields = (path: string, object: string | null, as: string) => {
      const route = routes.find((r) => r.method === "GET" && r.path === path);
      const described = ref.objects.find((o) => o.key === object);
      const names = [...(described?.fields ?? []), ...(route?.returns?.fields ?? [])].flatMap((f) =>
        // A list route names what it adds to each row as `posts[].fire_at`.
        f.name.replace(`${as}[].`, "").split(/,\s*/),
      );
      const rows = (route?.example?.response as Record<string, unknown> | undefined)?.[as];
      const examples = [described?.example, Array.isArray(rows) ? rows[0] : undefined];
      const keys = examples.flatMap((e) => keysOf(e, "").map((k) => k.slice(1)));
      return new Set([...names, ...keys]);
    };
    const lists: [string, string[], Set<string>][] = [
      ["posts", Object.keys(POST_LIST_SPEC.columns), rowFields("/api/posts", "post", "posts")],
      ["sends", Object.keys(SEND_LIST_SPEC.columns), rowFields("/api/sends", "send", "sends")],
      [
        "subscribers",
        Object.keys(SUBSCRIBER_LIST_SPEC.columns),
        rowFields("/api/subscribers", "subscriber", "subscribers"),
      ],
      [
        "deliveries",
        Object.keys(DELIVERY_LIST_SPEC.columns),
        rowFields("/api/sends/:id/deliveries", null, "deliveries"),
      ],
    ];
    const bad = lists.flatMap(([list, keys, fields]) =>
      keys
        .filter((k) => !fields.has(k) || !k.split(".").every((seg) => SNAKE.test(seg)))
        .map((k) => `${list}: sort=${k}`),
    );
    expect(bad).toEqual([]);
  });
});
