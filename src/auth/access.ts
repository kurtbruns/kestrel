/**
 * Cloudflare Access JWT validation (defense-in-depth behind the edge gate).
 *
 * Access forwards the signed assertion in `Cf-Access-Jwt-Assertion`. We verify
 * it against the team's JWKS and check `iss`/`aud`. A token with an `email`
 * claim is an interactive human; a service token (Claude) has no email.
 * Returns `null` when Access isn't configured or the token is invalid.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
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

export async function verifyAccessJwt(token: string, config: Config): Promise<Principal | null> {
  if (!config.accessTeamDomain || !config.accessAud) return null;
  const issuer = `https://${config.accessTeamDomain}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: config.accessAud,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return { kind: email ? "human" : "service", email };
  } catch {
    return null;
  }
}
