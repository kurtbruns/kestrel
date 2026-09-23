/**
 * Minimal zero-dependency router built on the runtime's `URLPattern`.
 *
 * Every route is declared as data — a `RouteDef` — and `register` is the one door
 * that turns a def into a live route. The declared `access` tier DRIVES the gate:
 * `admin` attaches `requireAuth`, `public`/`webhook` attach nothing (a webhook is
 * verified inside its adapter). Because the same field is what the generated API
 * reference reads (see src/reference/), the documented tier and the enforced gate
 * cannot disagree.
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
import { badRequest, type HttpError, json, toErrorResponse } from "./lib/errors";

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
  example?: RouteExample;
  handler: Handler;
  /** Extra middleware beyond the access-derived gate. Rare; composed after the gate. */
  middleware?: Middleware[];
}

/** The one place the access tier maps to a gate — so the tier can't drift from it. */
function gateFor(access: Access): Middleware[] {
  return access === "admin" ? [requireAuth] : [];
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
    const gate = gateFor(def.access);
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
