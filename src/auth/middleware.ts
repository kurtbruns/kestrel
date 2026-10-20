/**
 * Auth middleware for the admin/authoring surface.
 *
 * One contract: verify a signed token → `Principal`. In deployed environments the
 * Cloudflare Access JWT (forwarded by the edge) is the credential; in local dev,
 * where there is no Access edge, a dev-signed token stands in via the same shape
 * (`dev_token.ts`), enabled only when `config.devAuthSecret` is set. On success it
 * sets `c.principal`; otherwise it returns 401 and the route handler never runs. A person's
 * principal also carries the client the request came through, as it named itself in the
 * `Kestrel-Client` header; a malformed name is a 400 naming the header, checked after the
 * credential, as the API meets a request's faults in that order (SPEC §11, Who acted).
 * Before Access is set up on a deployment, no request can authenticate at all, and the
 * 401 says so (`reason: "access_not_configured"`) so the editor can tell that apart
 * from a session that ended; so does one whose Access login names neither a person nor
 * a service token (`reason: "access_unidentified"`), which signing in the same way again
 * can't fix either (SPEC §11).
 */
import type { UnauthorizedBody, UnauthorizedReason } from "../../shared/errors";
import { CLIENT_HEADER, isClientName } from "../../shared/who_acted";
import type { AppEnv, Config } from "../env";
import { fieldError } from "../lib/body";
import { json } from "../lib/errors";
import type { Middleware, Principal } from "../router";
import { ACCESS_JWT_HEADER, verifyAccessJwt } from "./access";
import { verifyDevToken } from "./dev_token";

export async function authenticate(
  req: Request,
  _env: AppEnv,
  config: Config,
): Promise<Principal | "access_unidentified" | null> {
  const jwt = req.headers.get(ACCESS_JWT_HEADER);
  if (jwt) {
    const p = await verifyAccessJwt(jwt, config);
    if (p) {
      return p;
    }
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

/**
 * Why no request can authenticate, when the configuration alone decides it: no Access
 * outside a dev-shaped env leaves no door at all. Null when a door exists and this
 * request simply failed it, which is all a 401 under Access says unless its login named
 * no one.
 */
function lockedReason(config: Config): Extract<UnauthorizedReason, "access_not_configured"> | null {
  // `getConfig` holds the Access pair to both or neither, so one stands for both.
  return !config.accessTeamDomain && !config.accessAud && !config.devShaped
    ? "access_not_configured"
    : null;
}

/** Route middleware: require a valid principal or 401. */
export const requireAuth: Middleware = async (c) => {
  const principal = await authenticate(c.req, c.env, c.config);
  if (!principal || principal === "access_unidentified") {
    const reason = principal ?? lockedReason(c.config);
    const body: UnauthorizedBody = reason
      ? { error: "unauthorized", reason }
      : { error: "unauthorized" };
    return json(body, 401, { "WWW-Authenticate": 'Bearer realm="kestrel"' });
  }
  const client = c.req.headers.get(CLIENT_HEADER);
  if (client !== null && !isClientName(client)) {
    throw fieldError(
      CLIENT_HEADER,
      `${CLIENT_HEADER} must be one short lowercase word, its parts joined by hyphens (editor, claude-code).`,
    );
  }
  // A service token already names the program, so a client's name on it changes nothing.
  c.principal =
    principal.kind === "human" && client !== null ? { ...principal, client } : principal;
  return undefined;
};
