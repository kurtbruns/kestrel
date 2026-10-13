import { afterEach, describe, expect, it } from "vitest";
import { ApiError, api, apiFile, apiText, describeError } from "./api";
import { setToken } from "./auth";
import { $, type FakeApi, fakeApi, jsonResponse, resetShell } from "./test/support";

describe("api", () => {
  let fake: FakeApi;
  afterEach(() => {
    fake?.restore();
    setToken("");
    resetShell();
    document.body.classList.remove("signed-out");
  });

  it("attaches the dev token as a bearer, and sends none without one", async () => {
    fake = fakeApi([{ path: "/api/posts", reply: () => ({ posts: [] }) }]);
    await api("/api/posts");
    expect(fake.calls[0]?.headers.get("authorization")).toBeNull();
    setToken("t0k");
    await api("/api/posts");
    expect(fake.calls[1]?.headers.get("authorization")).toBe("Bearer t0k");
  });

  it("sends json with its content type, and parses the answer", async () => {
    fake = fakeApi([
      { method: "POST", path: "/api/posts", reply: (req) => ({ echo: req.json() }) },
    ]);
    const out = await api<{ echo: { subject: string } }>("/api/posts", {
      method: "POST",
      json: { subject: "Owls" },
    });
    expect(out.echo.subject).toBe("Owls");
    expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(fake.calls[0]?.body).toBe(`{"subject":"Owls"}`);
  });

  it("returns null for an empty body", async () => {
    fake = fakeApi([
      { method: "DELETE", path: "/api/posts/1", reply: () => new Response(null, { status: 204 }) },
    ]);
    expect(await api("/api/posts/1", { method: "DELETE" })).toBeNull();
  });

  it("throws an ApiError carrying the status, the body, and its message", async () => {
    fake = fakeApi([
      {
        method: "PUT",
        path: "/api/posts/1",
        reply: () => jsonResponse({ error: "conflict", message: "Draft changed elsewhere" }, 409),
      },
      { path: "/x", reply: () => new Response("", { status: 500, statusText: "Boom" }) },
    ]);
    const err = await api("/api/posts/1", { method: "PUT" }).catch((e: unknown) => e);
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
    fake = fakeApi([{ path: "/api/posts", reply: () => new Response("", { status: 401 }) }]);
    await expect(api("/api/posts")).rejects.toMatchObject({
      status: 401,
      message: /sign in again/,
    });
    // The real wall, not a mock: the chrome hides and the page offers the one recovery.
    expect(document.body.classList.contains("signed-out")).toBe(true);
    expect($("#app .auth-wall #reauth").textContent).toBe("Sign in");
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

  it("apiText and apiFile throw the server's message and body, as api() does", async () => {
    const notFound = () => jsonResponse({ error: "not_found", message: "post" }, 404);
    fake = fakeApi([
      { path: "/page", reply: notFound },
      { path: "/file", reply: notFound },
    ]);
    const expected = { status: 404, message: "post", code: "not_found" };
    await expect(apiText("/page")).rejects.toMatchObject(expected);
    await expect(apiFile("/file")).rejects.toMatchObject(expected);
  });

  it("says what failed when the error body is not the API's, from every reader", async () => {
    // A proxy's HTML page has no message to give; over HTTP/2 there is no status text either.
    const proxyPage = () =>
      new Response("<html><body>Bad gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    fake = fakeApi([
      { path: "/json", reply: proxyPage },
      { path: "/text", reply: proxyPage },
      { path: "/file", reply: proxyPage },
      { path: "/named", reply: () => new Response("", { status: 503, statusText: "Busy" }) },
    ]);
    const expected = { status: 502, message: "Request failed (HTTP 502)", data: null };
    await expect(api("/json")).rejects.toMatchObject(expected);
    await expect(apiText("/text")).rejects.toMatchObject(expected);
    await expect(apiFile("/file")).rejects.toMatchObject(expected);
    await expect(apiText("/named")).rejects.toMatchObject({ status: 503, message: "Busy" });
  });
});

describe("describeError", () => {
  it("keeps a server message written for people", () => {
    const msg = "Add a subject before you schedule.";
    expect(describeError(new ApiError(msg, 400, { error: "subject_required", message: msg }))).toBe(
      msg,
    );
  });

  it("puts a bare code, a bare noun, and a dropped connection into the publisher's words", () => {
    expect(describeError(new ApiError("internal_error", 500))).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
    expect(describeError(new ApiError("Request failed (HTTP 502)", 502))).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
    expect(describeError(new ApiError("post", 404))).toBe(
      "It isn’t there any more. It may have been deleted elsewhere.",
    );
    expect(describeError(new TypeError("Failed to fetch"))).toBe(
      "Couldn’t reach Kestrel. Check your connection and try again.",
    );
    expect(describeError(new TypeError("Load failed"))).toBe(
      "Couldn’t reach Kestrel. Check your connection and try again.",
    );
  });

  it("treats an HTTP status text from a body that isn't the API's as no message at all", () => {
    expect(describeError(new ApiError("Bad Gateway", 502, null))).toBe(
      "Something went wrong on the server. Try again in a moment.",
    );
  });

  it("leaves a programming error's own text alone rather than blaming the connection", () => {
    expect(describeError(new TypeError("x is undefined"))).toBe("x is undefined");
    expect(describeError(new TypeError("x.fetch is not a function"))).toBe(
      "x.fetch is not a function",
    );
  });
});
