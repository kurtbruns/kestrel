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
import { requireAuth } from "./auth/middleware";
import type { AppEnv, Config } from "./env";
import { getConfig } from "./env";
import { badRequest, json, toErrorResponse } from "./lib/errors";

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

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * The access tier a route is served at. `admin` is gated by `requireAuth`;
 * `public` (reader/subscribe/archive/media) and `webhook` (provider callbacks,
 * verified inside the adapter) carry no auth middleware.
 */
export type Access = "admin" | "public" | "webhook";

/** A worked request/response pair for the API reference. Hand-authored, co-located with the route. */
export interface RouteExample {
  request?: unknown;
  response?: unknown;
}

/** A documented query parameter, for list routes with filter/sort/pagination. */
export interface QueryParam {
  name: string;
  description: string;
}

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

      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.pathname.groups)) {
        if (v !== undefined) {
          params[k] = decodeURIComponent(v);
        }
      }

      const c: RequestContext = { req, env, ctx, url, params, config };
      try {
        for (const mw of route.middleware) {
          const short = await mw(c);
          if (short) {
            return short;
          }
        }
        return await route.def.handler(c);
      } catch (err) {
        return toErrorResponse(err);
      }
    }

    return json({ error: "not_found" }, 404);
  }
}
