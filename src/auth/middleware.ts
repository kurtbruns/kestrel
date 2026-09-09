/**
 * Auth middleware for the admin/authoring surface.
 *
 * One contract: verify a signed token → `Principal`. In deployed environments the
 * Cloudflare Access JWT (forwarded by the edge) is the credential; in local dev,
 * where there is no Access edge, a dev-signed token stands in via the same shape
 * (`dev_token.ts`), enabled only when `config.devAuthSecret` is set. On success it
 * sets `c.principal`; otherwise it returns 401 and the route handler never runs.
 */
import type { AppEnv } from "../env";
import type { Config } from "../env";
import type { Middleware, Principal } from "../router";
import { json } from "../lib/errors";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "./access";
import { verifyDevToken } from "./dev_token";

export async function authenticate(
  req: Request,
  _env: AppEnv,
  config: Config,
): Promise<Principal | null> {
  const jwt = req.headers.get(ACCESS_JWT_HEADER);
  if (jwt) {
    const p = await verifyAccessJwt(jwt, config);
    if (p) return p;
  }
  // Local dev only: a dev-signed token carried as a bearer. `devAuthSecret` is
  // resolved only in a dev-shaped env AND is never committed (it lives in the
  // gitignored `.dev.vars`), so a deployed Worker has no secret and this path is
  // inert — Access is then the only door.
  if (config.devAuthSecret) {
    const auth = req.headers.get("Authorization");
    if (auth?.startsWith("Bearer ")) {
      return verifyDevToken(auth.slice("Bearer ".length), config.devAuthSecret);
    }
  }
  return null;
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
