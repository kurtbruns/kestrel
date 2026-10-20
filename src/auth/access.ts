/**
 * Cloudflare Access JWT validation (defense-in-depth behind the edge gate).
 *
 * Access forwards the signed assertion in `Cf-Access-Jwt-Assertion`. We verify
 * it against the team's JWKS and check `iss`/`aud`, then map its claims to a
 * principal: an `email` is an interactive human, and a `common_name` is a service
 * token, named by its Client ID (SPEC §11). A verified token with neither came
 * through some other kind of Access rule, and is refused rather than admitted as
 * an anonymous service, since nothing about it says who or what it is, and the 401
 * says why (`access_unidentified`), since signing in again the same way can't help.
 * Returns `null` when Access isn't configured, the token is invalid, or the allowlist
 * refuses the person.
 */
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { UnauthorizedReason } from "../../shared/errors";
import type { Config } from "../env";
import { log } from "../lib/log";
import type { Principal } from "../router";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

// Cache one JWKS resolver per issuer for the lifetime of the isolate.
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

function jwksFor(issuer: string): JWTVerifyGetKey {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

/**
 * Is this human admin allowed? An empty/unset allowlist admits any valid Access
 * login. The allowlist gates HUMANS only — service tokens carry no email and are
 * already gated by the Access Service Auth policy.
 */
export function isHumanAllowed(email: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) {
    return true;
  }
  return allowed.includes(email.toLowerCase());
}

/** A verified Access token that names neither a person nor a service token. */
type Unidentified = Extract<UnauthorizedReason, "access_unidentified">;

export async function verifyAccessJwt(
  token: string,
  config: Config,
): Promise<Principal | Unidentified | null> {
  if (!config.accessTeamDomain || !config.accessAud) {
    return null;
  }
  const issuer = `https://${config.accessTeamDomain}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: config.accessAud,
    });
    return principalFromClaims(payload, config.accessAllowedEmails);
  } catch {
    return null;
  }
}

/**
 * Map a verified Access token's claims to a principal, `null` for a human the allowlist
 * refuses, or `access_unidentified` for a token that is neither a person nor a service
 * token. A service call, and an unidentified one, logs the names of the claims it carried, never
 * their values, since a Client ID is half of the token's credential.
 */
export function principalFromClaims(
  payload: JWTPayload,
  allowed: string[] | undefined,
): Principal | Unidentified | null {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (email) {
    return isHumanAllowed(email, allowed) ? { kind: "human", email, via: "access" } : null;
  }
  const claims = Object.keys(payload).sort().join(",");
  // A service token carries its Client ID in `common_name`, already authorized by the
  // app's Service Auth policy.
  const tokenId = typeof payload.common_name === "string" ? payload.common_name : undefined;
  if (tokenId) {
    log.info("auth.service", { claims });
    return { kind: "service", tokenId, via: "access" };
  }
  // Neither a person nor a service token: some other kind of Access rule admitted it.
  // Refused, and warned about so the operator can find which rule.
  log.warn("auth.unidentified", { claims });
  return "access_unidentified";
}
