/**
 * Auth middleware for the admin/authoring surface.
 *
 * Tries the Cloudflare Access JWT first (the production gate), then falls back
 * to a bearer token (local dev / CI, and a documented portable fallback).
 * On success it sets `c.principal`; otherwise it returns 401 and the route
 * handler never runs.
 */
import type { AppEnv, Config } from "../env";
import { json } from "../lib/errors";
import type { Middleware, Principal } from "../router";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "./access";
import { checkBearer } from "./bearer";

export async function authenticate(
  req: Request,
  env: AppEnv,
  config: Config,
): Promise<Principal | null> {
  const jwt = req.headers.get(ACCESS_JWT_HEADER);
  if (jwt) {
    const p = await verifyAccessJwt(jwt, config);
    if (p) {
      return p;
    }
  }
  return checkBearer(req, env);
}

/** Route middleware: require a valid principal or 401. */
export const requireAuth: Middleware = async (c) => {
  const principal = await authenticate(c.req, c.env, c.config);
  if (!principal) {
    return json({ error: "unauthorized" }, 401, {
      "WWW-Authenticate": 'Bearer realm="kestrel"',
    });
  }
  c.principal = principal;
  return undefined;
};
