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
 *
 * A token that fails verification is refused with one `auth.refused` line saying why
 * (SPEC §12), so a locked-out operator can tell a mistyped audience from a wrong team
 * domain or an expired sign-in, and so is a verified person the allowlist leaves out. When the team's keys can't be fetched the token is neither
 * valid nor invalid: the answer is `access_unreachable`, which the middleware turns into
 * a 503 to try again, never a 401 that sends the person to sign in again for nothing.
 */
import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
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

/** The team's keys couldn't be fetched, so the token could be neither verified nor refused. */
export type Unreachable = "access_unreachable";

/**
 * Why a sign-in was refused, as `auth.refused` names it: the catalog an operator filters
 * on, so a name here is public surface. All but `not_allowed` are a token that failed
 * verification; `not_allowed` is a verified person the allowlist leaves out.
 */
export type RefusedReason =
  | "jwks_unreachable"
  | "expired"
  | "not_yet_valid"
  | "audience"
  | "issuer"
  | "signature"
  | "malformed"
  | "not_allowed";

// What jose throws when the keys themselves can't be had: a timeout, an answer that isn't a
// key set, and its one generic error, which only the key fetch throws (not 200, not JSON).
const JWKS_FAILURES: ReadonlySet<string> = new Set([
  errors.JWKSTimeout.code,
  errors.JWKSInvalid.code,
  errors.JOSEError.code,
]);

/**
 * Read a verification failure as its reason, from the class of jose's error and, for a claim,
 * the claim's name: never from its message or the claims it carries, so nothing of the token
 * can reach the log. An error that isn't jose's came from the key fetch itself (the network).
 */
export function refusedReason(err: unknown): Exclude<RefusedReason, "not_allowed"> {
  if (!(err instanceof errors.JOSEError) || JWKS_FAILURES.has(err.code)) {
    return "jwks_unreachable";
  }
  if (err instanceof errors.JWTExpired) {
    return "expired";
  }
  if (err instanceof errors.JWTClaimValidationFailed) {
    // A start time still ahead of this clock: the two clocks disagree, the token is real.
    if (err.claim === "nbf" && err.reason === "check_failed") {
      return "not_yet_valid";
    }
    return err.claim === "aud" ? "audience" : err.claim === "iss" ? "issuer" : "malformed";
  }
  // No key of the team's signed it: a forged token, or one another team issued.
  if (
    err instanceof errors.JWSSignatureVerificationFailed ||
    err instanceof errors.JWKSNoMatchingKey ||
    err instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return "signature";
  }
  return "malformed";
}

export async function verifyAccessJwt(
  token: string,
  config: Config,
): Promise<Principal | Unidentified | Unreachable | null> {
  if (!config.accessTeamDomain || !config.accessAud) {
    return null;
  }
  const issuer = `https://${config.accessTeamDomain}`;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(issuer), {
      issuer,
      audience: config.accessAud,
    }));
  } catch (err) {
    const reason = refusedReason(err);
    log.warn("auth.refused", { reason });
    return reason === "jwks_unreachable" ? "access_unreachable" : null;
  }
  const principal = principalFromClaims(payload, config.accessAllowedEmails);
  if (principal === null) {
    // A verified person the allowlist leaves out. Logged without the email, which Access's
    // own log has, so every 401 on a request that carried an assertion has its one line:
    // this, a failed check above, or `auth.unidentified`.
    const reason: RefusedReason = "not_allowed";
    log.warn("auth.refused", { reason });
  }
  return principal;
}

/**
 * Map a verified Access token's claims to a principal, `null` for a human the allowlist
 * refuses, or `access_unidentified` for a token that is neither a person nor a service
 * token. An unidentified one logs the names of the claims it carried, never their values, since
 * a Client ID is half of a service token's credential.
 */
export function principalFromClaims(
  payload: JWTPayload,
  allowed: string[] | undefined,
): Principal | Unidentified | null {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (email) {
    return isHumanAllowed(email, allowed) ? { kind: "human", email, via: "access" } : null;
  }
  // A service token carries its Client ID in `common_name`, already authorized by the
  // app's Service Auth policy.
  const tokenId = typeof payload.common_name === "string" ? payload.common_name : undefined;
  if (tokenId) {
    return { kind: "service", tokenId, via: "access" };
  }
  // Neither a person nor a service token: some other kind of Access rule admitted it.
  // Refused, and warned about so the operator can find which rule.
  log.warn("auth.unidentified", { claims: Object.keys(payload).sort().join(",") });
  return "access_unidentified";
}
