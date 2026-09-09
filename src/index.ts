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
import { sweep } from "./send/sweep";

const router = createRouter();

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return router.handle(request, env as AppEnv, ctx);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sweep(env as AppEnv));
  },
} satisfies ExportedHandler<Env>;
