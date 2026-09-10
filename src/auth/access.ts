/**
 * Cloudflare Access JWT validation (defense-in-depth behind the edge gate).
 *
 * Access forwards the signed assertion in `Cf-Access-Jwt-Assertion`. We verify
 * it against the team's JWKS and check `iss`/`aud`. A token with an `email`
 * claim is an interactive human; a service token (Claude) has no email.
 * Returns `null` when Access isn't configured or the token is invalid.
 */
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Config } from "../env";
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

export async function verifyAccessJwt(token: string, config: Config): Promise<Principal | null> {
  if (!config.accessTeamDomain || !config.accessAud) {
    return null;
  }
  const issuer = `https://${config.accessTeamDomain}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: config.accessAud,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (email) {
      if (!isHumanAllowed(email, config.accessAllowedEmails)) {
        return null;
      }
      return { kind: "human", email };
    }
    // No email → an Access service token (Claude/automation), already authorized
    // by the app's Service Auth policy.
    return { kind: "service" };
  } catch {
    return null;
  }
}
