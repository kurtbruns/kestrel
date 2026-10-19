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
 * route declares in `accepts`, which the reference shows too. On the API, a query parameter
 * or body key the route doesn't declare is refused next, before the handler
 * (`src/lib/strict.ts`); a reader page and a webhook take what they are sent, since a link in
 * an email gathers parameters its reader never added.
 *
 * Middleware run in order; the first one to return a `Response` short-circuits
 * (this is how auth returns 401 before the handler runs). Handlers and middleware
 * share a `RequestContext`. All errors funnel through `toErrorResponse`, so
 * handlers can just `throw new HttpError(...)`. The one exception is an error nothing
 * handled on a page a reader opens (`readerPage`), which is logged the same way and answered
 * with an HTML page rather than the API's JSON body.
 */
import type {
  Access,
  BodyField,
  QueryParam,
  Resource,
  RouteExample,
  RouteReturns,
} from "../shared/reference";
import { requireAuth } from "./auth/middleware";
import type { AppEnv, Config } from "./env";
import { getConfig } from "./env";
import { mediaTypeOf } from "./lib/body";
import {
  badRequest,
  HttpError,
  json,
  logUncaught,
  toErrorResponse,
  unsupportedMediaType,
} from "./lib/errors";
import { serverErrorPage } from "./lib/page";
import { refuseUndeclared } from "./lib/strict";
import type { RefusalCode } from "./reference/refusals";

export interface Principal {
  /** `human` = a person, with an email (an Access login, or the local dev token);
   *  `service` = a token with no email (Claude or automation, through Access or the dev token). */
  kind: "human" | "service";
  email?: string;
  /** A service token's Client ID (Access's `common_name`, or the dev token's stand-in),
   *  which names the token so two are told apart and the right one revoked (SPEC §11).
   *  Absent on a human, and on a service token that carried none. */
  tokenId?: string;
  /** The client a person's request came through, as it named itself in `Kestrel-Client`
   *  (`editor`, `claude-code`): never proven, only recorded (SPEC §11, Who acted). Absent
   *  when the request named none, and on a service token, which already names the program. */
  client?: string;
  /** How this request authenticated: a Cloudflare Access assertion, or the local dev token.
   *  What `auth.mode` reports, so it says how the caller got in rather than what is configured. */
  via: "access" | "dev";
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
// middleware), the worked example, and the documented query parameter and body field are what the API
// reference projects from a route, so they live in shared/ where the editor reads the
// same definitions; re-exported here under the manifest's names.
export type { Access, BodyField, QueryParam, RouteExample };

/** A refusal as a route declares it: the code, from the codes the API refuses with. */
export interface RouteRefusal {
  code: RefusalCode;
  /** What is this route's own about it; absent when the code's one line says it all. */
  when?: string;
  /** The fields its body carries beside `error` and `message`; `field` only on a code outside
   *  Fix the request, since the Errors topic states it once for every code in that group. */
  details?: string[];
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
  /** What the route acts on; the reference groups by it within the tier. */
  resource: Resource;
  /** The route named by what it does ("Schedule a post"), which the reference leads with. */
  title: string;
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
  /**
   * The body's fields, documented beside the route that reads them. Authored, not derived
   * from the reader, so review keeps the two in step; a spec holds every route that takes a
   * body to carrying one.
   */
  body?: BodyField[];
  /** What it answers: an object the reference describes once, and the fields of its own. */
  returns?: RouteReturns;
  /**
   * The refusals this route gives of its own, each one line, its status read from the code.
   * Leave out the ones every route of the tier shares (no credential, a cross-site write, a
   * body type it doesn't take, a malformed field, a path id that names nothing), which the
   * reference states once.
   */
  errors?: RouteRefusal[];
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
 * Whether a browser started this request from a page other than the admin's own. A current
 * browser says so in `Sec-Fetch-Site`, which a page can't forge. An older one doesn't send
 * it but does send `Origin` on a POST, so that decides instead: an origin other than the
 * request's own (or `null`, an opaque one) is foreign. The request's own origin, not
 * `APP_ORIGIN`, so an instance reachable on two hostnames never refuses its own editor.
 * With neither header it is not a browser, and passes.
 */
function isForeignBrowserRequest(c: RequestContext): boolean {
  const site = c.req.headers.get("sec-fetch-site");
  if (site !== null) {
    return !OWN_FETCH_SITES.has(site.toLowerCase());
  }
  const origin = c.req.headers.get("origin");
  return origin !== null && origin !== c.url.origin;
}

/** Whether a request's body is empty or only whitespace, read from a clone so the body stays unread. */
async function isEmptyBody(req: Request): Promise<boolean> {
  const bytes = await req.clone().arrayBuffer();
  return new TextDecoder().decode(bytes).trim() === "";
}

/**
 * Refuse a write another site's page could have made the publisher's browser send with
 * their session (SPEC §11): one a browser marks as foreign (`isForeignBrowserRequest`),
 * and one declaring a body type the route doesn't take, since a plain HTML form can only
 * send a form encoding or `text/plain` and a page can't send any other type across
 * origins without a preflight the app never grants. A request that declares no type
 * passes the second check; the route's reader decides whether a body without one is
 * acceptable (`readJsonObject` refuses one that is not empty). On a route that takes no
 * body, an empty body declared `application/json` passes too, since HTTP helpers send that
 * type by habit and it is the one type no page elsewhere can send without a preflight.
 */
function refuseForeignWrite(accepts: readonly string[]): Middleware {
  return async (c) => {
    if (isForeignBrowserRequest(c)) {
      throw new HttpError(
        "cross_site_request",
        "a page on another site can't act on the admin API",
      );
    }
    const type = mediaTypeOf(c.req);
    if (type !== undefined && !accepts.includes(type)) {
      if (accepts.length === 0 && type === "application/json" && (await isEmptyBody(c.req))) {
        return undefined;
      }
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

  /** `readerPage` says whether a path is one a reader opens in a browser, where an error
   *  nothing handled is answered with a page rather than JSON. */
  constructor(private readonly readerPage: (pathname: string) => boolean = () => false) {}

  /** Register a route from its manifest entry; the `access` tier decides the gate. */
  register(def: RouteDef): this {
    // On the API, after the gate (so an unauthenticated request still gets its 401), what
    // the route doesn't declare is refused; a reader page and a webhook take what they're sent.
    const strict =
      def.access !== "webhook" && !this.readerPage(def.path) ? [refuseUndeclared(def)] : [];
    const middleware = [...gateFor(def), ...strict, ...(def.middleware ?? [])];
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
        if (!(err instanceof HttpError) && this.readerPage(url.pathname)) {
          logUncaught(err);
          return guard(route.def.access, serverErrorPage());
        }
        return guard(route.def.access, toErrorResponse(err));
      }
    }

    return json({ error: "not_found" }, 404);
  }
}
