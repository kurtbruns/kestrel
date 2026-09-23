import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import {
  oneOf,
  optObject,
  optString,
  optStringList,
  optStringOrNull,
  readJsonObject,
} from "../src/lib/body";
import { HttpError } from "../src/lib/errors";
import type { RequestContext } from "../src/router";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

function send(method: string, path: string, body: string, contentType = "application/json") {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: { ...AUTH, "content-type": contentType },
    body,
  });
}

/** The 400 a refused request carries: status, code, and the field it names (if any). */
async function expect400(res: Response, field?: string): Promise<any> {
  expect(res.status).toBe(400);
  const body = await readJson(res);
  expect(body.error).toBe("bad_request");
  if (field !== undefined) {
    expect(body.field).toBe(field);
    expect(body.message).toContain(field);
  }
  return body;
}

async function newDraft(markdown = "v1"): Promise<{ id: string; revision_id: string }> {
  const res = await send("POST", "/posts", JSON.stringify({ subject: "Boundary", markdown }));
  const body = await readJson(res);
  return { id: body.post.id, revision_id: body.revision_id };
}

function ctxFor(body: string): RequestContext {
  return {
    req: new Request(base, { method: "POST", body }),
  } as unknown as RequestContext;
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<HttpError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("readJsonObject", () => {
  it("returns a JSON object as parsed", async () => {
    expect(await readJsonObject(ctxFor('{"a":1}'))).toEqual({ a: 1 });
  });

  it("refuses an absent body unless it is optional", async () => {
    expect((await refusal(readJsonObject(ctxFor("")))).status).toBe(400);
    expect(await readJsonObject(ctxFor(""), { optional: true })).toEqual({});
  });

  it("refuses a body that is not JSON, even when optional", async () => {
    const e = await refusal(readJsonObject(ctxFor("{nope"), { optional: true }));
    expect(e.message).toMatch(/not valid JSON/);
  });

  it("refuses null, an array, and a scalar, naming which it got", async () => {
    expect((await refusal(readJsonObject(ctxFor("null")))).message).toMatch(/not null/);
    expect((await refusal(readJsonObject(ctxFor("[1]")))).message).toMatch(/not an array/);
    expect((await refusal(readJsonObject(ctxFor('"x"')))).message).toMatch(/not string/);
  });
});

describe("field readers", () => {
  it("leave an absent field absent and pass a well-typed one through", () => {
    expect(optString({}, "a")).toBeUndefined();
    expect(optString({ a: "x" }, "a")).toBe("x");
    expect(optStringOrNull({ a: null }, "a")).toBeNull();
    expect(optStringList({ a: ["x"] }, "a")).toEqual(["x"]);
    expect(optObject({ a: {} }, "a")).toEqual({});
    expect(oneOf({ a: "y" }, "a", ["x", "y"])).toBe("y");
  });

  it("refuse a wrong type with the field's full name", async () => {
    const cases: [() => unknown, string][] = [
      [() => optString({ a: 1 }, "a"), "a"],
      [() => optString({ a: null }, "a"), "a"],
      [() => optStringOrNull({ a: 1 }, "a"), "a"],
      [() => optStringList({ a: ["x", 2] }, "a"), "a"],
      [() => optObject({ a: [] }, "a"), "a"],
      [() => oneOf({}, "a", ["x"]), "a"],
      [() => optString({ name: 1 }, "name", "publication"), "publication.name"],
    ];
    for (const [read, field] of cases) {
      const e = await refusal(read);
      expect(e.status).toBe(400);
      expect(e.details).toEqual({ field });
      expect(e.message).toContain(field);
    }
  });
});

describe("a body that is not a JSON object is a 400 on every JSON route", () => {
  it("null and an array are refused, not a 500", async () => {
    const { id } = await newDraft();
    const routes: [string, string][] = [
      ["PUT", `/posts/${id}`],
      ["POST", `/posts/${id}/schedule`],
      ["POST", "/subscribers"],
      ["POST", "/suppressions"],
      ["POST", "/sends/s_missing/reschedule"],
      ["POST", "/sends/s_missing/resolve"],
      ["PUT", "/api/settings"],
    ];
    for (const [method, path] of routes) {
      for (const body of ["null", "[]"]) {
        const res = await send(method, path, body);
        expect(res.status, `${method} ${path} ${body}`).toBe(400);
      }
    }
  });
});

describe("PUT /posts/:id refuses a wrong shape instead of dropping it", () => {
  it("a wrongly typed field is a 400 naming it, and the post is unchanged", async () => {
    const { id, revision_id } = await newDraft();
    await expect400(await send("PUT", `/posts/${id}`, JSON.stringify({ subject: 123 })), "subject");
    const got = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
    expect(got.post.subject).toBe("Boundary");
    expect(got.post.current_revision).toBe(revision_id);
  });

  it("a malformed base_revision is a 400, never a save that skips the concurrency check", async () => {
    const { id } = await newDraft();
    // Another writer saves first, so a checked save from the stale base would 409.
    const other = await send("PUT", `/posts/${id}`, JSON.stringify({ markdown: "theirs" }));
    const { revision_id: theirs } = await readJson(other);
    for (const bad of [1, true, {}, ["r"]]) {
      const res = await send(
        "PUT",
        `/posts/${id}`,
        JSON.stringify({ markdown: "mine", base_revision: bad }),
      );
      await expect400(res, "base_revision");
    }
    const got = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
    expect(got.markdown).toBe("theirs");
    expect(got.post.current_revision).toBe(theirs);
  });

  it("base_revision: null still means no base", async () => {
    const { id } = await newDraft();
    const res = await send(
      "PUT",
      `/posts/${id}`,
      JSON.stringify({ markdown: "v2", base_revision: null }),
    );
    expect(res.status).toBe(200);
  });

  it("a body that is not JSON is a 400, not a 200 no-op", async () => {
    const { id, revision_id } = await newDraft();
    await expect400(await send("PUT", `/posts/${id}`, "markdown=v2", "text/plain"));
    const got = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
    expect(got.post.current_revision).toBe(revision_id);
  });

  it("POST /posts with no JSON body still creates a blank draft", async () => {
    const res = await SELF.fetch(`${base}/posts`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(201);
  });
});

describe("other routes name the field they refuse", () => {
  it("subscribers, suppressions, resolve, settings", async () => {
    await expect400(await send("POST", "/subscribers", JSON.stringify({ email: 1 })), "email");
    await expect400(
      await send("POST", "/suppressions", JSON.stringify({ email: "a@example.com", reason: 5 })),
      "reason",
    );
    await expect400(
      await send("POST", "/sends/s_missing/resolve", JSON.stringify({ resolution: "maybe" })),
      "resolution",
    );
    await expect400(
      await send("PUT", "/api/settings", JSON.stringify({ publication: { name: 7 } })),
      "publication.name",
    );
    await expect400(
      await send("PUT", "/api/settings", JSON.stringify({ publication: "Name" })),
      "publication",
    );
    await expect400(
      await send("PUT", "/api/settings", JSON.stringify({ remake: "s_1" })),
      "remake",
    );
  });
});

describe("PUT /api/settings keeps a database failure out of the 400", () => {
  it("a failing settings read is a 500, not a bad request carrying the database's message", async () => {
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: database unavailable");
        },
      },
    } as unknown as AppEnv;
    const req = new Request(`${base}/api/settings`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ publication: { name: "Fine" } }),
    });
    const res = await createRouter(getConfig(env as AppEnv)).handle(
      req,
      broken,
      createExecutionContext(),
    );
    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({ error: "internal_error" });
  });
});

describe("a malformed percent-escape in a path is a 400", () => {
  it("on a public route", async () => {
    const res = await SELF.fetch(`${base}/archive/%E0`);
    await expect400(res);
  });

  it("on an admin route", async () => {
    const res = await SELF.fetch(`${base}/posts/%E0%A4`, { headers: AUTH });
    await expect400(res);
  });

  it("only after the gate: an unauthenticated admin request is still a 401", async () => {
    const res = await SELF.fetch(`${base}/posts/%E0%A4`);
    expect(res.status).toBe(401);
  });
});
