/*
 * What `kestrel api` reads from an instance's OpenAPI document (packages/kestrel/lib/openapi.mjs): the routes
 * it lists and describes, the body or query string `-f` and `-F` build, the field it refuses
 * before the request as the router would, and a refusal printed readably beside its raw body.
 * The document is a stub written in the shapes the Worker's projection uses
 * (src/reference/openapi.ts), whose own spec holds the real one to them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiCommand, parseApiArgs } from "../../packages/kestrel/lib/api.mjs";
import { writeSignIn } from "../../packages/kestrel/lib/credentials.mjs";
import {
  buildFields,
  describeRefusal,
  describeRoute,
  findOperation,
  listRoutes,
  nextMove,
  typedValue,
} from "../../packages/kestrel/lib/openapi.mjs";

const ORIGIN = "https://news.example.com";

const SHARED = {
  description:
    "A refusal any route can give: `unauthorized` (401; next move: Sign in, or stop), `internal_error` (500; next move: Try again shortly, unchanged).",
  content: { "application/json": { schema: { $ref: "#/components/schemas/error" } } },
};

/** A refusal response as the projection writes one: each code, when, and its next move. */
const refusals = (...rows) => ({
  description: rows
    .map(([code, when, move]) => `\`${code}\`: ${when} Next move: ${move}.`)
    .join("\n\n"),
});

const DOC = {
  openapi: "3.1.0",
  info: { title: "Kestrel API", version: "9.9.9", description: "" },
  tags: [{ name: "Posts" }, { name: "Sends" }, { name: "Settings" }, { name: "Archive" }],
  paths: {
    "/api/posts": {
      get: {
        summary: "List posts",
        tags: ["Posts"],
        "x-kestrel-access": "admin",
        parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string" } },
          {
            name: "dir",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["asc", "desc"] },
          },
          { name: "Kestrel-Client", in: "header", required: false, schema: { type: "string" } },
        ],
        responses: { default: SHARED },
      },
      post: {
        summary: "Create a post",
        description: "Start a draft.",
        tags: ["Posts"],
        "x-kestrel-access": "admin",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  subject: { type: "string", description: "The subject line." },
                  listed: { type: "boolean", description: "Whether the archive lists it." },
                  fire_at: {
                    anyOf: [{ type: "integer" }, { type: "string", format: "date-time" }],
                    description: "When it goes.",
                  },
                  priority: { type: ["number", "null"] },
                  resolution: { enum: ["unsent", "accepted"] },
                  tags: { type: "array", items: { type: "string" } },
                  counts: { type: "array", items: { type: "integer" } },
                  publication: {
                    type: "object",
                    properties: { name: { type: "string", description: "Its name." } },
                    required: ["name"],
                  },
                  extra: { type: "object" },
                },
                required: ["subject"],
              },
              example: { subject: "Hello" },
            },
          },
        },
        responses: {
          "2XX": {
            description: "Create a post",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { post: { $ref: "#/components/schemas/post" } },
                  required: ["post"],
                },
              },
            },
          },
          409: refusals(["slug_taken", "Another post holds the slug.", "Read again, then decide"]),
          default: SHARED,
        },
      },
    },
    "/api/posts/{id}/images": {
      post: {
        summary: "Upload an image",
        tags: ["Posts"],
        "x-kestrel-access": "admin",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { type: "object", properties: { file: { type: "string" } } },
            },
            "image/png": { schema: { type: "string", contentMediaType: "image/png" } },
          },
        },
        responses: { default: SHARED },
      },
    },
    // A parameter path ahead of the literal one, so the match can't win by order.
    "/api/sends/{id}": {
      get: { summary: "Get a send", tags: ["Sends"], "x-kestrel-access": "admin", responses: {} },
    },
    "/api/sends/feed": {
      get: {
        summary: "Follow changes to sends",
        tags: ["Sends"],
        "x-kestrel-access": "admin",
        responses: {},
      },
    },
    "/api/sends/{id}/cancel": {
      post: {
        summary: "Cancel a send",
        tags: ["Sends"],
        "x-kestrel-access": "admin",
        responses: {
          409: refusals([
            "send_started",
            "The send has begun.",
            "Nothing: the act no longer applies",
          ]),
          default: SHARED,
        },
      },
    },
    "/api/settings/logo": {
      post: {
        summary: "Upload the logo",
        tags: ["Settings"],
        "x-kestrel-access": "admin",
        parameters: [{ name: "remake", in: "query", required: false, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { type: "object", properties: { file: { type: "string" } } },
            },
          },
        },
        responses: { default: SHARED },
      },
      delete: {
        summary: "Remove the logo",
        tags: ["Settings"],
        "x-kestrel-access": "admin",
        parameters: [{ name: "remake", in: "query", required: false, schema: { type: "string" } }],
        responses: { default: SHARED },
      },
    },
    "/archive": {
      get: {
        summary: "Show the archive",
        tags: ["Archive"],
        "x-kestrel-access": "public",
        responses: {},
      },
    },
  },
  components: { schemas: { post: { type: "object", title: "Post", properties: {} } } },
};

const route = (method, path) => findOperation(DOC, method, path);
const f = (text) => ({ typed: false, text });
const F = (text) => ({ typed: true, text });

describe("reading kestrel api's arguments", () => {
  it("takes -f and -F, long or short, in order, each repeatable", () => {
    const args = parseApiArgs([
      "post",
      "/api/posts",
      "-f",
      "subject=Hi",
      "-F",
      "listed=true",
      "--raw-field=tags[]=a",
      "--field",
      "counts[]=2",
    ]);
    expect(args.mode).toBe("call");
    expect(args.fields).toEqual([
      f("subject=Hi"),
      F("listed=true"),
      f("tags[]=a"),
      F("counts[]=2"),
    ]);
  });

  it("reads --list, help, and help <method> <path> as listing and describing, never a call", () => {
    expect(parseApiArgs(["--list"])).toMatchObject({ mode: "list", resource: undefined });
    expect(parseApiArgs(["--list", "sends", "--local"])).toMatchObject({
      mode: "list",
      resource: "sends",
      local: true,
    });
    expect(parseApiArgs(["--list=sends"])).toMatchObject({ mode: "list", resource: "sends" });
    expect(parseApiArgs(["help"])).toMatchObject({ mode: "list", resource: undefined });
    expect(parseApiArgs(["help", "sends"])).toMatchObject({ mode: "list", resource: "sends" });
    expect(parseApiArgs(["help", "post", "/api/posts"])).toMatchObject({
      mode: "help",
      method: "POST",
      path: "/api/posts",
    });
  });

  it("refuses a body sent two ways, and a body or field given to --list or help", () => {
    expect(() => parseApiArgs(["POST", "/x", "--data", "{}", "--form", "a=1"])).toThrow(/one way/);
    expect(() => parseApiArgs(["--local=yes", "--list"])).toThrow(
      "--local takes no value; to name a server, use --url <url>.",
    );
    expect(() => parseApiArgs(["--list", "-f", "a=1"])).toThrow(/take no body or fields/);
    expect(() => parseApiArgs(["POST", "/x", "-f"])).toThrow(/-f needs a value/);
    expect(() => parseApiArgs(["POST", "/x", "-x", "1"])).toThrow(/^unknown option -x/);
  });
});

describe("listing the instance's routes", () => {
  it("groups every route under its resource, marking one that takes no sign-in", () => {
    const text = listRoutes(DOC);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Posts",
      "  GET    /api/posts              List posts",
      "  POST   /api/posts              Create a post",
      "  POST   /api/posts/{id}/images  Upload an image",
    ]);
    expect(text).toContain("  GET    /archive                Show the archive (public)");
  });

  it("narrows to one resource named in any case, and names the resources when none matches", () => {
    const text = listRoutes(DOC, "SENDS");
    expect(text).toContain("Follow changes to sends");
    expect(text).not.toContain("Create a post");
    expect(() => listRoutes(DOC, "nope")).toThrow(
      'This instance has no resource named "nope"; it has posts, sends, settings, archive.',
    );
  });
});

describe("describing one route", () => {
  it("matches a concrete path to its template, a literal segment over a parameter", () => {
    expect(route("POST", "/api/posts/p_1/images")?.path).toBe("/api/posts/{id}/images");
    expect(route("get", "/api/sends/feed")?.path).toBe("/api/sends/feed");
    expect(route("GET", "/api/sends/s_1?x=1")?.path).toBe("/api/sends/{id}");
    expect(route("DELETE", "/api/posts")).toBeUndefined();
  });

  it("gives its fields with type and need, its answer, and each refusal with its next move", () => {
    const text = describeRoute(DOC, "POST", "/api/posts");
    expect(text).toContain("POST /api/posts\nCreate a post (Posts)\n\nStart a draft.");
    expect(text).toContain("  subject  string, required\n      The subject line.");
    expect(text).toContain("  fire_at  integer | string (date-time)\n      When it goes.");
    expect(text).toContain("  publication.name  string, required\n      Its name.");
    expect(text).toContain("Returns\n  post  post");
    expect(text).toContain(
      "  409 slug_taken: Another post holds the slug.\n      Next move: Read again, then decide.",
    );
    expect(text).toContain("  Any route: unauthorized (401), internal_error (500)");
  });

  it("says how to send a body that isn't JSON", () => {
    expect(describeRoute(DOC, "POST", "/api/posts/p_1/images")).toContain(
      "  Send it as --form name=value or name=@file; or the file itself, with --data @file --type image/png.",
    );
  });

  it("refuses a route the instance doesn't have", () => {
    expect(() => describeRoute(DOC, "GET", "/nowhere")).toThrow(/no route GET \/nowhere/);
  });
});

describe("building a body from -f and -F", () => {
  const post = route("POST", "/api/posts");

  it("sends -f as a string and -F typed by the field's schema", () => {
    const { body } = buildFields(DOC, post, [
      f("subject=true"),
      F("listed=false"),
      F("fire_at=1768467600000"),
      F("priority=null"),
      F("resolution=accepted"),
    ]);
    expect(body).toEqual({
      subject: "true",
      listed: false,
      fire_at: 1768467600000,
      priority: null,
      resolution: "accepted",
    });
    expect(buildFields(DOC, post, [F("fire_at=2026-05-01T09:00:00Z")]).body).toEqual({
      fire_at: "2026-05-01T09:00:00Z",
    });
  });

  it("nests a dotted name, adds to a list with [], reads JSON for a loose object, and reads @file", () => {
    const { body } = buildFields(
      DOC,
      post,
      [
        f("publication.name=Field Notes"),
        f("tags[]=a"),
        f("tags[]=b"),
        F("counts[]=3"),
        F('extra={"k":1}'),
        F("subject=@post.md"),
      ],
      { readFile: (file) => `read ${file}` },
    );
    expect(body).toEqual({
      publication: { name: "Field Notes" },
      tags: ["a", "b"],
      counts: [3],
      extra: { k: 1 },
      subject: "read post.md",
    });
  });

  it("refuses an undeclared field before the request, naming the fields the route takes", () => {
    expect(() => buildFields(DOC, post, [f("subjct=Hi")])).toThrow(
      "subjct isn’t a field POST /api/posts takes; it takes 'subject', 'listed', 'fire_at', 'priority', 'resolution', 'tags', 'counts', 'publication', 'extra'. `kestrel api help POST /api/posts` describes it.",
    );
    expect(() => buildFields(DOC, post, [f("publication.nme=x")])).toThrow(
      /^publication\.nme isn’t a field POST \/api\/posts takes; it takes 'name'\./,
    );
  });

  it("lets a declared field with no declared children take any keys, as the router does", () => {
    expect(buildFields(DOC, post, [F("extra.any=1")]).body).toEqual({ extra: { any: "1" } });
  });

  it("refuses a value its type can't take, a field given twice, and [] on a field that isn't a list", () => {
    expect(() => buildFields(DOC, post, [F("listed=yes")])).toThrow(
      'listed takes boolean, not "yes".',
    );
    expect(() => buildFields(DOC, post, [F("resolution=maybe")])).toThrow(
      'resolution takes "unsent" | "accepted", not "maybe".',
    );
    expect(() => buildFields(DOC, post, [f("subject=a"), f("subject=b")])).toThrow(
      /subject is given more than once/,
    );
    expect(() => buildFields(DOC, post, [f("subject[]=a")])).toThrow(/subject isn't a list/);
  });

  it("puts a GET's fields in its query string, checked against its query parameters", () => {
    const list = route("GET", "/api/posts");
    expect(buildFields(DOC, list, [f("status=draft"), F("dir=asc")])).toEqual({
      query: [
        ["status", "draft"],
        ["dir", "asc"],
      ],
    });
    expect(() => buildFields(DOC, list, [f("Kestrel-Client=x")])).toThrow(
      /^Kestrel-Client isn’t a query parameter GET \/api\/posts takes; it takes 'status', 'dir'\./,
    );
    expect(() => buildFields(DOC, list, [F("dir=up")])).toThrow(
      'dir takes "asc" | "desc", not "up".',
    );
  });

  it("puts a name another method's route takes only as a query parameter in its query string", () => {
    expect(buildFields(DOC, route("DELETE", "/api/settings/logo"), [f("remake=s_1")])).toEqual({
      query: [["remake", "s_1"]],
    });
    expect(() => buildFields(DOC, route("DELETE", "/api/settings/logo"), [f("logo=x")])).toThrow(
      /^DELETE \/api\/settings\/logo takes no body\. Its query parameters are 'remake'\./,
    );
  });

  it("refuses fields for a route that takes no JSON body, saying how to send what it does take", () => {
    expect(() => buildFields(DOC, route("POST", "/api/posts/p_1/images"), [f("a=b")])).toThrow(
      /takes no JSON body; it takes multipart\/form-data, image\/png: send it with --form/,
    );
    expect(() => buildFields(DOC, route("POST", "/api/sends/s_1/cancel"), [f("a=b")])).toThrow(
      /^POST \/api\/sends\/\{id\}\/cancel takes no body\./,
    );
  });

  it("types a value against a schema with nothing to say as an object or list when it is one, else the string as given", () => {
    expect(typedValue("[1,2]", {}, "x", DOC)).toEqual([1, 2]);
    expect(typedValue('{"a":1}', {}, "x", DOC)).toEqual({ a: 1 });
    expect(typedValue("2026", {}, "x", DOC)).toBe("2026");
    expect(typedValue("true", {}, "x", DOC)).toBe("true");
    expect(typedValue("plain", {}, "x", DOC)).toBe("plain");
  });
});

describe("a refusal, readable", () => {
  it("gives its code, message, field, and the next move the route's document names", () => {
    const op = route("POST", "/api/posts").op;
    expect(
      describeRefusal(
        { error: "slug_taken", message: "Another post holds that slug.", field: "slug" },
        { doc: DOC, op },
      ),
    ).toEqual([
      "slug_taken: Another post holds that slug.",
      "field: slug",
      "next move: Read again, then decide.",
    ]);
  });

  it("finds a code any route gives, or one another route lists, since a code's move is the same anywhere", () => {
    expect(nextMove(DOC, "unauthorized")).toBe("Sign in, or stop");
    expect(nextMove(DOC, "send_started", route("GET", "/api/posts").op)).toBe(
      "Nothing: the act no longer applies",
    );
    expect(nextMove(DOC, "never_heard_of_it")).toBeUndefined();
  });

  // SPEC §11: a 401 signing in again can't fix says why, and its move is outside the API.
  it("gives a 401's reason, and for one signing in can't fix, what to change instead", () => {
    const unidentified = describeRefusal(
      { error: "unauthorized", reason: "access_unidentified", message: "Access sent no one." },
      { doc: DOC },
    );
    expect(unidentified.slice(0, 2)).toEqual([
      "unauthorized: Access sent no one.",
      "reason: access_unidentified",
    ]);
    expect(unidentified[2]).toMatch(
      /^next move: Access let you in but sent neither an email address nor a service token, .* logging in again the same way gets the same answer\. .*Lock the dashboard with Access \(https:\/\/getkestrel\.dev\/docs\/access\/\)\.$/,
    );
    expect(unidentified).toHaveLength(3);

    // An older instance sends the reason with no message; the move stands on the reason.
    const locked = describeRefusal(
      { error: "unauthorized", reason: "access_not_configured" },
      { doc: DOC },
    );
    expect(locked.slice(0, 2)).toEqual(["unauthorized", "reason: access_not_configured"]);
    expect(locked[2]).toMatch(/^next move: The instance has no Cloudflare Access in front of it/);

    expect(
      describeRefusal({ error: "unauthorized", message: "Sign in: no credential." }, { doc: DOC }),
    ).toEqual(["unauthorized: Sign in: no credential.", "next move: Sign in, or stop."]);
  });

  it("is nothing for a body that isn't a refusal", () => {
    expect(describeRefusal({ post: {} }, { doc: DOC })).toBeUndefined();
    expect(describeRefusal("text", { doc: DOC })).toBeUndefined();
  });
});

describe("kestrel api against a signed-in instance", () => {
  let dir;
  let out;
  let err;
  let calls;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kestrel-api-"));
    vi.stubEnv("KESTREL_CONFIG_DIR", dir);
    vi.stubEnv("KESTREL_URL", ORIGIN);
    await writeSignIn(ORIGIN, {
      token_endpoint: "https://team.cloudflareaccess.com/token",
      client_id: "c",
      access_token: "oauth:good",
      expires_at: Date.now() + 3_600_000,
      refresh_token: "r",
    });
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => out.push(String(s)) > 0);
    vi.spyOn(console, "log").mockImplementation((s) => out.push(`${s}\n`));
    vi.spyOn(console, "error").mockImplementation((s) => err.push(String(s)));
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    calls = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Answer the document at its path and `answer` for anything else, recording each request. */
  function serve(answer) {
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      calls.push({ path, method: init.method ?? "GET", body: init.body, headers: init.headers });
      if (path === "/api/openapi.json") {
        return new Response(JSON.stringify(DOC), {
          headers: { "content-type": "application/json" },
        });
      }
      return answer();
    });
  }

  it("lists the routes from the instance's own document, through the sign-in", async () => {
    serve(() => new Response("unexpected", { status: 500 }));
    await apiCommand(["--list", "posts"]);
    expect(calls.map((c) => c.path)).toEqual(["/api/openapi.json"]);
    expect(calls[0].headers.authorization).toBe("Bearer oauth:good");
    expect(out.join("")).toContain("  POST   /api/posts              Create a post");
  });

  it("sends the body -f and -F build, as JSON", async () => {
    serve(() => new Response('{"post":{}}', { status: 201 }));
    await apiCommand(["POST", "/api/posts", "-f", "subject=Spring update", "-F", "listed=true"]);
    const sent = calls.find((c) => c.path === "/api/posts");
    expect(sent.method).toBe("POST");
    expect(JSON.parse(sent.body)).toEqual({ subject: "Spring update", listed: true });
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(out.join("")).toBe('{"post":{}}\n');
  });

  it("makes no call when a field is undeclared", async () => {
    serve(() => new Response("{}"));
    await expect(apiCommand(["POST", "/api/posts", "-f", "subjct=Hi"])).rejects.toThrow("exit 1");
    expect(calls.map((c) => c.path)).toEqual(["/api/openapi.json"]);
    expect(err.join("\n")).toMatch(/^kestrel api: subjct isn’t a field POST \/api\/posts takes/);
  });

  it("prints a refusal's body whole on stdout and its code, message, field, and next move on stderr", async () => {
    const refusal = {
      error: "slug_taken",
      message: "Another post holds that slug.",
      field: "slug",
    };
    serve(() => new Response(JSON.stringify(refusal), { status: 409, statusText: "Conflict" }));
    await expect(apiCommand(["POST", "/api/posts", "--data", '{"subject":"Hi"}'])).rejects.toThrow(
      "exit 1",
    );
    expect(out.join("")).toBe(`${JSON.stringify(refusal)}\n`);
    expect(err).toEqual([
      "kestrel api: HTTP 409 Conflict",
      "  slug_taken: Another post holds that slug.",
      "  field: slug",
      "  next move: Read again, then decide.",
    ]);
  });

  it("still prints the refusal when the document can't be read, only without its move", async () => {
    vi.stubGlobal("fetch", async (url) =>
      new URL(String(url)).pathname === "/api/openapi.json"
        ? new Response("{}", { status: 404 })
        : new Response('{"error":"not_found","message":"post"}', {
            status: 404,
            statusText: "Not Found",
          }),
    );
    await expect(apiCommand(["GET", "/api/posts/p_1"])).rejects.toThrow("exit 1");
    expect(err).toEqual(["kestrel api: HTTP 404 Not Found", "  not_found: post"]);
  });

  it("sends a query-parameter field beside a form, and refuses a body field beside one", async () => {
    serve(() => new Response("{}"));
    await apiCommand(["POST", "/api/settings/logo", "--form", "file=x", "-f", "remake=s_1"]);
    const sent = calls.find((c) => c.path.startsWith("/api/settings/logo"));
    expect(sent.path).toBe("/api/settings/logo?remake=s_1");
    expect(sent.body).toBeInstanceOf(FormData);
    calls.length = 0;
    await expect(
      apiCommand(["POST", "/api/posts", "--data", "{}", "-f", "subject=Hi"]),
    ).rejects.toThrow("exit 1");
    expect(calls.map((c) => c.path)).toEqual(["/api/openapi.json"]);
    expect(err.at(-1)).toBe(
      "kestrel api: Send the body one way: --data, --form, or -f and -F fields, not two.",
    );
  });

  it("says an instance with no OpenAPI document runs an older release", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    await expect(apiCommand(["--list"])).rejects.toThrow("exit 1");
    expect(err).toEqual([
      "kestrel api: This instance serves no /api/openapi.json, so its routes can't be listed or checked: it runs a release older than this CLI's. Send a body with --data instead.",
    ]);
  });

  it("reads a loopback instance's document as its dev server's stand-in person, with no sign-in", async () => {
    vi.stubEnv("KESTREL_URL", "http://localhost:8799");
    vi.stubGlobal("fetch", async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers });
      return String(url).includes("/api/dev/token")
        ? new Response(JSON.stringify({ token: "dev-token", run_id: "run-a" }))
        : new Response(JSON.stringify(DOC));
    });
    await apiCommand(["--list", "sends"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:8799/api/dev/token?kind=human",
      "http://localhost:8799/api/openapi.json",
    ]);
    expect(calls[1].headers.authorization).toBe("Bearer dev-token");
    expect(calls[1].headers["kestrel-client"]).toBe("claude-code");
    expect(out.join("")).toContain("Get a send");
  });

  it("writes a -F @file's text into the body", async () => {
    const file = join(dir, "post.md");
    writeFileSync(file, "# Hello\n");
    serve(() => new Response("{}", { status: 201 }));
    await apiCommand(["POST", "/api/posts", "-F", `subject=@${file}`]);
    expect(JSON.parse(calls.find((c) => c.path === "/api/posts").body)).toEqual({
      subject: "# Hello\n",
    });
  });
});
