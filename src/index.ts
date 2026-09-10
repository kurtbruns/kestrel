/**
 * Kestrel — Worker entry point.
 *
 * One Worker exposes both handlers (spec §6, §13):
 *   - fetch()     → HTTP API + public reader pages + archive + webhooks,
 *                   dispatched by the URLPattern router (see app.ts / router.ts)
 *   - scheduled() → the reconciling send sweep, once a minute (see send/sweep.ts)
 */

import { createRouter } from "./app";
import type { AppEnv } from "./env";
import { getConfig } from "./env";
import type { Router } from "./router";
import { sweep } from "./send/sweep";

// The archive route is config-driven (ARCHIVE_BASE_PATH), and bindings are only
// available per-request — so build the router lazily and cache it per base path.
const routers = new Map<string, Router>();
function routerFor(env: AppEnv): Router {
  const basePath = getConfig(env).archiveBasePath;
  let router = routers.get(basePath);
  if (!router) {
    router = createRouter(basePath);
    routers.set(basePath, router);
  }
  return router;
}

/**
 * The admin SPA moved from `/admin/` to `/dashboard/`. Redirect old bookmarks with a
 * permanent, path- and query-preserving 301, so a saved `/admin/…?x=1` lands on the
 * matching `/dashboard/…?x=1`. This is an admin→admin path-compatibility shim — the
 * new path is gated exactly like the old one, so there's no §10 concern — and it is
 * deliberately not a manifest route: it's not part of the API surface the reference
 * documents, and it sits ahead of the router the same way static assets do.
 */
function legacyAdminRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) {
    return null;
  }
  const rest = url.pathname.slice("/admin".length); // "" (bare /admin) or "/<subpath>"
  const location = new URL(`/dashboard${rest || "/"}${url.search}`, url);
  return Response.redirect(location.toString(), 301);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const appEnv = env as AppEnv;
    const redirect = legacyAdminRedirect(request);
    if (redirect) {
      return redirect;
    }
    return routerFor(appEnv).handle(request, appEnv, ctx);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sweep(env as AppEnv));
  },
} satisfies ExportedHandler<Env>;
