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
import { ConfigError, getConfig } from "./env";
import { json } from "./lib/errors";
import { log, newRun, withRun } from "./lib/log";
import type { Router } from "./router";
import { sweep } from "./send/sweep";

// The archive route is config-driven (ARCHIVE_BASE_PATH), whether the dev routes exist
// follows devMode, and the reference states the minimum lead, but bindings are only
// available per-request, so build the router lazily and cache it per (base path, dev mode,
// lead).
const routers = new Map<string, Router>();
function routerFor(env: AppEnv): Router {
  const config = getConfig(env);
  const key = `${config.archiveBasePath}|${config.devMode}|${config.minLeadMs}`;
  let router = routers.get(key);
  if (!router) {
    router = createRouter(config);
    routers.set(key, router);
  }
  return router;
}

// The last deploy-config error logged, so a broken deployment logs its cause once per
// isolate rather than on every request and every sweep tick.
let reportedConfigError: string | undefined;

/** Log a deploy-config error the first time it is seen. */
function reportConfigError(err: ConfigError): void {
  if (reportedConfigError !== err.message) {
    reportedConfigError = err.message;
    log.error("config.invalid", { variable: err.variable, message: err.message });
  }
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    // Every line a request logs, including work it leaves to `waitUntil`, carries its ray.
    return withRun(request.headers.get("cf-ray") ?? newRun(), () =>
      handleFetch(request, env as AppEnv, ctx),
    );
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const appEnv = env as AppEnv;
    try {
      getConfig(appEnv);
    } catch (err) {
      if (err instanceof ConfigError) {
        reportConfigError(err); // the sweep would only fail the same way, every minute
        return;
      }
      throw err;
    }
    ctx.waitUntil(withRun(newRun(), () => sweep(appEnv)));
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(
  request: Request,
  appEnv: AppEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  let router: Router;
  try {
    router = routerFor(appEnv);
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      throw err;
    }
    // Refuse every request, naming the variable to fix, rather than run on config that
    // would do the wrong thing quietly.
    reportConfigError(err);
    return json({ error: "invalid_config", message: err.message, variable: err.variable }, 500);
  }
  return router.handle(request, appEnv, ctx);
}
