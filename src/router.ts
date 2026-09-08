/**
 * Minimal zero-dependency router built on the runtime's `URLPattern`.
 *
 * A route is a method + path pattern + an optional middleware chain + a handler.
 * Middleware run in order; the first one to return a `Response` short-circuits
 * (this is how auth returns 401 before the handler runs). Handlers and
 * middleware share a `RequestContext`. All errors funnel through
 * `toErrorResponse`, so handlers can just `throw new HttpError(...)`.
 */
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
  if (v === undefined) throw badRequest(`missing path parameter: ${name}`);
  return v;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Route {
  method: Method;
  pattern: URLPattern;
  middleware: Middleware[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: Method, pathname: string, handler: Handler, middleware: Middleware[] = []): this {
    this.routes.push({ method, pattern: new URLPattern({ pathname }), middleware, handler });
    return this;
  }

  get = (p: string, h: Handler, m: Middleware[] = []) => this.add("GET", p, h, m);
  post = (p: string, h: Handler, m: Middleware[] = []) => this.add("POST", p, h, m);
  put = (p: string, h: Handler, m: Middleware[] = []) => this.add("PUT", p, h, m);
  delete = (p: string, h: Handler, m: Middleware[] = []) => this.add("DELETE", p, h, m);

  async handle(req: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const config = getConfig(env);

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.pathname.groups)) {
        if (v !== undefined) params[k] = decodeURIComponent(v);
      }

      const c: RequestContext = { req, env, ctx, url, params, config };
      try {
        for (const mw of route.middleware) {
          const short = await mw(c);
          if (short) return short;
        }
        return await route.handler(c);
      } catch (err) {
        return toErrorResponse(err);
      }
    }

    return json({ error: "not_found" }, 404);
  }
}
