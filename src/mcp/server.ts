/**
 * The instance's MCP server (SPEC §11): how Claude Desktop and claude.ai, which reach an outside
 * service only as a connector, work the same API the editor and Claude Code do. It answers MCP's
 * Streamable HTTP transport at `POST /api/mcp`, statelessly: every request stands alone, so no
 * session is kept, nothing is held between calls, and nothing streams. The access layer signs
 * the person in, through its managed OAuth, and the route's gate re-verifies the assertion as it
 * does on every admin route, so this module never sees a credential it has to judge.
 *
 * It speaks the protocol revisions opened by an `initialize` handshake (`MCP_PROTOCOL_VERSIONS`).
 * A client that asks for another in the version header is refused with a plain 400, which a
 * newer client takes as its sign to fall back to `initialize`. The tools are `tools.ts`; this is
 * only the envelope around them.
 */

import type { DocsResponse } from "../../shared/docs";
import {
  JSON_RPC_ERRORS,
  type JsonRpcId,
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSIONS,
  MCP_VERSION_HEADER,
  type ToolResult,
} from "../../shared/mcp";
import type { ReferenceResponse } from "../../shared/reference";
import { buildInfo } from "../build";
import { readJsonValue } from "../lib/body";
import { HttpError, json, logUncaught } from "../lib/errors";
import { log } from "../lib/log";
import { openApiDocument } from "../reference/openapi";
import type { RequestContext, Router } from "../router";
import { MCP_INSTRUCTIONS } from "./instructions";
import {
  API_READ_NAME,
  type Api,
  curatedTools,
  editorLink,
  mediaType,
  pathRequest,
  type RouteRef,
  readAnswer,
  refusalCodeOf,
  routeRequest,
  type ToolRoute,
  undeclaredField,
  unknownArgs,
} from "./tools";

export { CLAUDE_ORIGINS, MCP_PATH } from "./tools";

// The tools a router's manifest makes, built once per router: the manifest is fixed once built.
const toolsByRouter = new WeakMap<Router, ToolRoute[]>();

/** The tools `router` serves, from the reference and OpenAPI document its manifest generates. */
export function routerTools(router: Router, reference: () => ReferenceResponse): ToolRoute[] {
  let tools = toolsByRouter.get(router);
  if (!tools) {
    const ref = reference();
    tools = curatedTools(openApiDocument(ref, "", buildInfo().version));
    toolsByRouter.set(router, tools);
  }
  return tools;
}

const SUPPORTED: readonly string[] = MCP_PROTOCOL_VERSIONS;

function result(id: JsonRpcId, value: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result: value };
  return json(body);
}

function error(id: JsonRpcId | null, code: number, message: string, status = 200): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  return json(body, status);
}

/** A message the server takes and answers with nothing: a notification, or a client's response. */
function accepted(): Response {
  return new Response(null, { status: 202 });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `GET /api/mcp`: refused, since the server sends nothing a client didn't ask for. */
export function stream(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

/**
 * `POST /api/mcp`: one JSON-RPC message. `tools` are the router's; a tool call is handed back to
 * `router` as the request its route takes.
 */
export async function handle(
  c: RequestContext,
  router: Router,
  tools: readonly ToolRoute[],
): Promise<Response> {
  const read = await readJsonValue(c);
  if (read === null) {
    return error(null, JSON_RPC_ERRORS.parseError, "the body is not valid JSON", 400);
  }
  const msg = read?.value;
  if (Array.isArray(msg)) {
    return error(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      "a batch isn't taken: send one JSON-RPC message a request",
      400,
    );
  }
  if (!isObject(msg)) {
    return error(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      "the body must be one JSON-RPC message",
      400,
    );
  }
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  try {
    return await dispatch(c, router, tools, msg);
  } catch (err) {
    // A refusal about the request (a body type it can't take) keeps its own answer; anything
    // that failed on the server's side, a 5xx refusal included, is the protocol's internal error.
    if (err instanceof HttpError && err.status < 500) {
      throw err;
    }
    // Whatever failed, the client gets the protocol's answer for it, never a bare 500.
    logUncaught(err);
    return error(
      id,
      JSON_RPC_ERRORS.internalError,
      "Kestrel couldn't answer that: the server log says why.",
    );
  }
}

/** One JSON-RPC message, answered. */
async function dispatch(
  c: RequestContext,
  router: Router,
  tools: readonly ToolRoute[],
  msg: Record<string, unknown>,
): Promise<Response> {
  const version = c.req.headers.get(MCP_VERSION_HEADER);
  if (msg.method !== "initialize" && version !== null && !SUPPORTED.includes(version)) {
    return error(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      `${MCP_VERSION_HEADER} ${version} isn't served; this server speaks ${SUPPORTED.join(", ")}, opened by initialize`,
      400,
    );
  }
  if (msg.jsonrpc !== "2.0") {
    return error(null, JSON_RPC_ERRORS.invalidRequest, 'jsonrpc must be "2.0"', 400);
  }
  // A client's response to a request of ours (we make none) or a notification: taken, no answer.
  if (msg.method === undefined || msg.id === undefined) {
    return accepted();
  }
  const { id, method } = msg;
  if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") {
    return error(null, JSON_RPC_ERRORS.invalidRequest, "id must be a string or a number", 400);
  }
  const params = isObject(msg.params) ? msg.params : {};

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "kestrel", title: "Kestrel", version: buildInfo().version },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: tools.map((t) => t.tool) });
    case "tools/call": {
      const t = tools.find((x) => x.tool.name === params.name);
      if (!t) {
        return error(id, JSON_RPC_ERRORS.invalidParams, `no tool is named ${String(params.name)}`);
      }
      return result(id, await call(c, router, t, params.arguments));
    }
    case "resources/list":
      return result(id, { resources: await docResources(c, router) });
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      const contents = await readDoc(c, router, uri);
      return contents
        ? result(id, { contents: [contents] })
        : error(id, RESOURCE_NOT_FOUND, `no resource is at ${uri}`);
    }
    default:
      return error(
        id,
        JSON_RPC_ERRORS.methodNotFound,
        `${method} isn't a method this server takes`,
      );
  }
}

/** The JSON-RPC code MCP gives a resource that isn't there. */
const RESOURCE_NOT_FOUND = -32002;

/** Where a publishing doc is served as a resource: `kestrel://docs/<slug>`. */
const DOC_URI = "kestrel://docs/";

/** A route's request on the caller's behalf, through the router, read once. */
async function through(c: RequestContext, router: Router, r: RouteRef, parts = {}) {
  return readAnswer(
    await router.handle(routeRequest(r, parts, c.url.origin, c.req.headers), c.env, c.ctx),
  );
}

/** The publisher's docs as resources, from the docs route: the pages a publisher reads. */
async function docResources(c: RequestContext, router: Router) {
  const a = await through(c, router, { method: "GET", path: "/api/docs" });
  const docs = a.ok ? (a.body as DocsResponse).docs : [];
  return docs
    .filter((d) => d.set === "publishing")
    .map((d) => ({
      uri: `${DOC_URI}${d.slug}`,
      name: d.slug,
      title: d.title,
      mimeType: "text/markdown",
    }));
}

/** One publishing doc's Markdown, from the route that serves it to an agent, or null. */
async function readDoc(c: RequestContext, router: Router, uri: string) {
  const slug = uri.startsWith(DOC_URI) ? uri.slice(DOC_URI.length) : "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return null;
  }
  const a = await through(
    c,
    router,
    { method: "GET", path: "/api/docs/:name.md" },
    {
      params: { name: slug },
    },
  );
  return a.ok ? { uri, mimeType: "text/markdown", text: a.text } : null;
}

/** Whether a tool may call a route: one it declares, or any GET for the read escape hatch. */
function allows(t: ToolRoute, r: RouteRef): boolean {
  return t.def.name === API_READ_NAME
    ? r.method === "GET"
    : t.def.routes.some((x) => x.method === r.method && x.path === r.path);
}

/** One tool call: the tool's run, each route it calls through the router as the caller. */
async function call(
  c: RequestContext,
  router: Router,
  t: ToolRoute,
  args: unknown,
): Promise<ToolResult> {
  if (args !== undefined && !isObject(args)) {
    return logged(t, {
      content: [{ type: "text", text: "arguments must be an object" }],
      isError: true,
    });
  }
  const given = args ?? {};
  const stray = unknownArgs(t, given);
  if (stray) {
    return logged(t, { content: [{ type: "text", text: stray }], isError: true });
  }
  const api: Api = {
    async call(r, parts = {}) {
      if (!allows(t, r)) {
        throw new Error(`${t.def.name} calls ${r.method} ${r.path}, which it doesn't declare`);
      }
      const stray = undeclaredField(t.def, r, parts);
      if (stray) {
        throw new Error(`${t.def.name} sends ${stray} to ${r.method} ${r.path}, undeclared`);
      }
      return through(c, router, r, parts);
    },
    async read(path) {
      if (t.def.name !== API_READ_NAME) {
        throw new Error(`${t.def.name} reads a path, which only ${API_READ_NAME} may`);
      }
      const res = await router.handle(pathRequest(path, c.url.origin, c.req.headers), c.env, c.ctx);
      const type = mediaType(res);
      return { ...(await readAnswer(res)), type };
    },
    editor: (page) => editorLink(c.config.appOrigin, page),
  };
  let out: ToolResult;
  try {
    out = await t.def.run(api, given);
  } catch (err) {
    logUncaught(err);
    out = {
      content: [
        {
          type: "text",
          text: "The tool stopped on an error inside Kestrel; the server log says why. Read again before trying again: a change it made before it stopped stands.",
        },
      ],
      isError: true,
    };
  }
  return logged(t, out);
}

/** A call's one line, with the code of the route refusal a failed call shows: a code, never its
 *  message or a value, so failed calls can be filtered without raising the level (SPEC §12). */
function logged(t: ToolRoute, out: ToolResult): ToolResult {
  log.info("mcp.call", { tool: t.tool.name, error: out.isError, code: refusalCodeOf(out) });
  return out;
}
