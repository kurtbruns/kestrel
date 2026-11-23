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
 * can't fix either (SPEC §11). A local dev server's 401 says a dev token can be minted
 * (`dev_token_available`), so a client asks for one only where the route exists. When
 * the Access team's keys can't be fetched, the sign-in may be fine and the app is what
 * can't check it, so the answer is a 503 (`access_unreachable`) saying when to try again.
 */
import type { ApiErrorBody, UnauthorizedBody, UnauthorizedReason } from "../../shared/errors";
import { CLIENT_HEADER, isClientName } from "../../shared/who_acted";
import type { AppEnv, Config } from "../env";
import { fieldError } from "../lib/body";
import { json } from "../lib/errors";
import { REFUSAL_STATUS } from "../reference/refusals";
import type { Middleware, Principal } from "../router";
import { ACCESS_JWT_HEADER, type Unreachable, verifyAccessJwt } from "./access";
import { verifyDevToken } from "./dev_token";

export async function authenticate(
  req: Request,
  _env: AppEnv,
  config: Config,
): Promise<Principal | "access_unidentified" | Unreachable | null> {
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

const SIGN_IN_MESSAGE =
  "Sign in: this request carries no credential, or one this deployment can't verify.";

// What a 401 that signing in again can't fix says, in the words the editor's wall uses.
const UNAUTHORIZED_MESSAGE: Record<UnauthorizedReason, string> = {
  access_not_configured:
    "No Cloudflare Access is set up in front of this deployment, so no request can sign in until it is. The guide Lock the dashboard with Access sets it up.",
  access_unidentified:
    "Cloudflare Access let this sign-in through but sent neither an email address nor a service token, so Kestrel can't tell who is asking. Signing in the same way again gets the same answer: Kestrel takes an Allow policy on people's emails or a Service Auth policy on a service token, as the guide Lock the dashboard with Access says.",
};

// How long a client waits before asking again when the team's keys couldn't be fetched:
// long enough for a blip to pass, short enough that a person retrying isn't kept out.
const UNREACHABLE_RETRY_SECONDS = 30;

/** The 503 for a sign-in the app couldn't check, with when to try again (SPEC §11). */
function unreachable(): Response {
  const body: ApiErrorBody & { retry_after: number } = {
    error: "access_unreachable",
    message:
      "Kestrel couldn't fetch Cloudflare Access's signing keys to check this sign-in, so it can't say whether the sign-in is good. Try again shortly. If this keeps happening, check that ACCESS_TEAM_DOMAIN names your Access team.",
    retry_after: Date.now() + UNREACHABLE_RETRY_SECONDS * 1000,
  };
  return json(body, REFUSAL_STATUS.access_unreachable, {
    "Retry-After": String(UNREACHABLE_RETRY_SECONDS),
  });
}

/** Route middleware: require a valid principal, or 401, or 503 when one can't be checked. */
export const requireAuth: Middleware = async (c) => {
  const principal = await authenticate(c.req, c.env, c.config);
  if (principal === "access_unreachable") {
    return unreachable();
  }
  if (!principal || principal === "access_unidentified") {
    const reason = principal ?? lockedReason(c.config);
    const body: UnauthorizedBody = reason
      ? { error: "unauthorized", message: UNAUTHORIZED_MESSAGE[reason], reason }
      : {
          error: "unauthorized",
          message: SIGN_IN_MESSAGE,
          ...(c.config.devMode ? { dev_token_available: true } : {}),
        };
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
