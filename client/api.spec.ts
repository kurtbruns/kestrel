import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiText } from "./api";
import { setToken } from "./auth";
import { type FakeApi, fakeApi, jsonResponse } from "./test_support";

vi.mock("./build_ref", () => ({ showReauth: vi.fn() }));

import { showReauth } from "./build_ref";

describe("api", () => {
  let fake: FakeApi;
  afterEach(() => {
    fake?.restore();
    setToken("");
    vi.mocked(showReauth).mockClear();
  });

  it("attaches the dev token as a bearer, and sends none without one", async () => {
    fake = fakeApi([{ path: "/posts", reply: () => ({ posts: [] }) }]);
    await api("/posts");
    expect(fake.calls[0]?.headers.get("authorization")).toBeNull();
    setToken("t0k");
    await api("/posts");
    expect(fake.calls[1]?.headers.get("authorization")).toBe("Bearer t0k");
  });

  it("sends json with its content type, and parses the answer", async () => {
    fake = fakeApi([{ method: "POST", path: "/posts", reply: (req) => ({ echo: req.json() }) }]);
    const out = await api<{ echo: { subject: string } }>("/posts", {
      method: "POST",
      json: { subject: "Owls" },
    });
    expect(out.echo.subject).toBe("Owls");
    expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(fake.calls[0]?.body).toBe(`{"subject":"Owls"}`);
  });

  it("returns null for an empty body", async () => {
    fake = fakeApi([
      { method: "DELETE", path: "/posts/1", reply: () => new Response(null, { status: 204 }) },
    ]);
    expect(await api("/posts/1", { method: "DELETE" })).toBeNull();
  });

  it("throws an ApiError carrying the status, the body, and its message", async () => {
    fake = fakeApi([
      {
        method: "PUT",
        path: "/posts/1",
        reply: () => jsonResponse({ error: "conflict", message: "Draft changed elsewhere" }, 409),
      },
      { path: "/x", reply: () => new Response("", { status: 500, statusText: "Boom" }) },
    ]);
    const err = await api("/posts/1", { method: "PUT" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      message: "Draft changed elsewhere",
      data: { error: "conflict" },
    });
    const bare = await api("/x").catch((e: unknown) => e);
    expect(bare).toMatchObject({ status: 500, message: "Boom", data: null });
  });

  it("routes a 401 to re-auth and throws", async () => {
    fake = fakeApi([{ path: "/posts", reply: () => new Response("", { status: 401 }) }]);
    await expect(api("/posts")).rejects.toMatchObject({ status: 401, message: /sign in again/ });
    expect(showReauth).toHaveBeenCalledTimes(1);
  });

  it("apiText returns the raw text with the same guards", async () => {
    fake = fakeApi([
      {
        path: "/preview",
        reply: () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }),
      },
      { path: "/nope", reply: () => new Response("", { status: 404, statusText: "Not Found" }) },
    ]);
    expect(await apiText("/preview")).toBe("<h1>hi</h1>");
    await expect(apiText("/nope")).rejects.toMatchObject({ status: 404, message: "Not Found" });
  });
});
