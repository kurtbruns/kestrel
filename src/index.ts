/**
 * Kestrel — Worker entry point.
 *
 * One Worker exposes both handlers (spec §6, §11):
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const appEnv = env as AppEnv;
    return routerFor(appEnv).handle(request, appEnv, ctx);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sweep(env as AppEnv));
  },
} satisfies ExportedHandler<Env>;
