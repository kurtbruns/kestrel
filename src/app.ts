/**
 * Composition root: build the Router and register all routes.
 *
 * M1 registers the system routes only:
 *   - GET /health       public liveness probe
 *   - GET /api/whoami   authed probe that echoes the resolved principal
 *
 * Content / images / render / subscribers / sends / public / archive / webhook
 * routes are mounted here as they land in later milestones.
 */
import { Router } from "./router";
import { json } from "./lib/errors";
import { requireAuth } from "./auth/middleware";

export function createRouter(): Router {
  const r = new Router();

  // Public liveness probe (no auth — health checks must not require a token).
  r.get("/health", () => json({ status: "ok", service: "kestrel" }));

  // Authed probe: proves the admin gate admits a valid principal and rejects
  // everyone else. Handy for verifying the Access service token end-to-end.
  r.get("/api/whoami", (c) => json({ principal: c.principal }), [requireAuth]);

  return r;
}
