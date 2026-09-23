/**
 * Minimal zero-dependency router built on the runtime's `URLPattern`.
 *
 * Every route is declared as data — a `RouteDef` — and `register` is the one door
 * that turns a def into a live route. The declared `access` tier DRIVES the gate:
 * `admin` attaches `requireAuth`, `public`/`webhook` attach nothing (a webhook is
 * verified inside its adapter). Because the same field is what the generated API
 * reference reads (see src/reference/), the documented tier and the enforced gate
 * cannot disagree. The admin gate also refuses a write another site's page could have
 * made the publisher's browser send (`refuseForeignWrite`), against the body types the
 * route declares in `accepts`, which the reference shows too.
 *
 * Middleware run in order; the first one to return a `Response` short-circuits
 * (this is how auth returns 401 before the handler runs). Handlers and middleware
 * share a `RequestContext`. All errors funnel through `toErrorResponse`, so
 * handlers can just `throw new HttpError(...)`.
 */
import type { Access, QueryParam, Resource, RouteExample } from "../shared/reference";
import { requireAuth } from "./auth/middleware";
import type { AppEnv, Config } from "./env";
import { getConfig } from "./env";
import { mediaTypeOf } from "./lib/body";
import { badRequest, HttpError, json, toErrorResponse, unsupportedMediaType } from "./lib/errors";

export interface Principal {
  /** `human` = interactive login (Access, has email); `service` = token (Claude / bearer). */
  kind: "human" | "service";
  email?: string;
}

export interface RequestContext {
  req: Request;
  env: AppEnv;
  ctx: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  config: Config;
  /** Set by the auth middleware once the request is authenticated. */
  principal?: Principal;
}

export type Middleware = (
  c: RequestContext,
) => Response | undefined | Promise<Response | undefined>;
export type Handler = (c: RequestContext) => Response | Promise<Response>;

/** Read a required path parameter (guaranteed present on a matched route). */
export function param(c: RequestContext, name: string): string {
  const v = c.params[name];
  if (v === undefined) {
    throw badRequest(`missing path parameter: ${name}`);
  }
  return v;
}

/**
 * Decode a route's path parameters. A malformed escape (`/archive/%E0`) is the
 * client's mistake, so it comes back as a 400 to throw rather than an uncaught
 * URIError; it is returned, not thrown, so the caller can run the gate first.
 */
function decodePathParams(groups: Record<string, string | undefined>): {
  params: Record<string, string>;
  error?: HttpError;
} {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(groups)) {
    if (v === undefined) {
      continue;
    }
    try {
      params[k] = decodeURIComponent(v);
    } catch {
      return { params, error: badRequest(`path parameter ${k} is not validly percent-encoded`) };
    }
  }
  return { params };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

// The access tier (`admin` is gated by `requireAuth`; `public` and `webhook` carry no auth
// middleware), the worked example, and the documented query parameter are what the API
// reference projects from a route, so they live in shared/ where the editor reads the
// same definitions; re-exported here under the manifest's names.
export type { Access, QueryParam, RouteExample };

/**
 * A route declared as data. `method` / `path` / `access` are accurate by
 * construction — they are what registers the route — and the same record drives
 * the generated API reference, so `summary` / `example` stay co-located with the
 * route they document (JSDoc-style) rather than in a separate, drift-prone table.
 */
export interface RouteDef {
  method: Method;
  path: string;
  access: Access;
  /** What the route acts on; the reference groups by it within the tier. */
  resource: Resource;
  summary: string;
  description?: string;
  /** Query parameters, documented from the registration so the reference can't drift. */
  query?: QueryParam[];
  /**
   * The media types the request body may carry (`application/json`, `multipart/form-data`,
   * or a raw upload's own types). Absent on a route that takes no body. On an admin write
   * a request declaring any other type is refused before the handler runs.
   */
  accepts?: readonly string[];
  example?: RouteExample;
  handler: Handler;
  /** Extra middleware beyond the access-derived gate. Rare; composed after the gate. */
  middleware?: Middleware[];
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * What a browser says of a request it sends from the admin's own pages (`same-origin`) or
 * one the person typed (`none`); any other value means a page elsewhere started it.
 * A client that isn't a browser (Claude's service token, curl, the tests) sends none.
 */
const OWN_FETCH_SITES: ReadonlySet<string> = new Set(["same-origin", "none"]);

/**
 * Refuse a write another site's page could have made the publisher's browser send with
 * their session (SPEC §11). A current browser marks such a request with `Sec-Fetch-Site`,
 * which a page can't forge. An older one doesn't, so the route's declared body types are
 * the second check: a plain HTML form can only send a form encoding or `text/plain`, and
 * a page can't send any other type across origins without a preflight the app never
 * grants. A request that declares no type passes here; the route's reader decides whether
 * a body without one is acceptable (`readJsonObject` refuses one that is not empty).
 */
function refuseForeignWrite(accepts: readonly string[]): Middleware {
  return (c) => {
    const site = c.req.headers.get("sec-fetch-site");
    if (site !== null && !OWN_FETCH_SITES.has(site.toLowerCase())) {
      throw new HttpError(
        403,
        "cross_site_request",
        "a page on another site can't act on the admin API",
      );
    }
    const type = mediaTypeOf(c.req);
    if (type !== undefined && !accepts.includes(type)) {
      throw unsupportedMediaType(
        accepts.length === 0
          ? `this route takes no body, so no Content-Type (got ${type})`
          : `this route accepts ${accepts.join(" or ")}, not ${type}`,
      );
    }
    return undefined;
  };
}

/**
 * The one place the access tier maps to a gate, so the tier can't drift from it: an
 * admin route requires auth, and an admin write also refuses a cross-site request.
 */
function gateFor(def: RouteDef): Middleware[] {
  if (def.access !== "admin") {
    return [];
  }
  return UNSAFE_METHODS.has(def.method)
    ? [requireAuth, refuseForeignWrite(def.accepts ?? [])]
    : [requireAuth];
}

/**
 * What the tier asks of every response, set here where the gate is attached so no admin
 * route can forget it: an admin response (authed JSON, the preview, a CSV export, and
 * the 401 itself) is never stored by a browser or a shared cache, since it is one
 * person's view behind the gate. Other tiers pass through unchanged.
 */
function guard(access: Access, res: Response): Response {
  if (access !== "admin") {
    return res;
  }
  // A fetched or cached Response can have immutable headers; a copy never does.
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}

interface CompiledRoute {
  def: RouteDef;
  pattern: URLPattern;
  middleware: Middleware[];
}

export class Router {
  private compiled: CompiledRoute[] = [];

  /** Register a route from its manifest entry; the `access` tier decides the gate. */
  register(def: RouteDef): this {
    const gate = gateFor(def);
    const middleware = def.middleware ? [...gate, ...def.middleware] : gate;
    this.compiled.push({ def, pattern: new URLPattern({ pathname: def.path }), middleware });
    return this;
  }

  /**
   * The registered routes, in registration order — the single source the API
   * reference is generated from, and the surface tests use to assert the gate
   * matches the declared tier.
   */
  get routes(): readonly CompiledRoute[] {
    return this.compiled;
  }

  async handle(req: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const config = getConfig(env);

    for (const route of this.compiled) {
      if (route.def.method !== req.method) {
        continue;
      }
      const match = route.pattern.exec(url);
      if (!match) {
        continue;
      }

      const { params, error: badParam } = decodePathParams(match.pathname.groups);
      const c: RequestContext = { req, env, ctx, url, params, config };
      try {
        for (const mw of route.middleware) {
          const short = await mw(c);
          if (short) {
            return guard(route.def.access, short);
          }
        }
        // Refused only after the gate, so an admin route answers an unauthenticated
        // request with its 401 whatever the path holds.
        if (badParam) {
          throw badParam;
        }
        return guard(route.def.access, await route.def.handler(c));
      } catch (err) {
        return guard(route.def.access, toErrorResponse(err));
      }
    }

    return json({ error: "not_found" }, 404);
  }
}
