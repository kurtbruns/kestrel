/**
 * Local dev credential: a JWT signed with a symmetric dev secret.
 *
 * In deployed environments Cloudflare Access issues the JWTs (human SSO + the
 * service token for Claude) and `access.ts` verifies them. Locally there is no
 * Access edge, so dev mints its own token and the app verifies it here — the
 * SAME contract (verify a signed token → `Principal`), a different key. This is
 * only ever active when `config.devAuthSecret` is set, which `getConfig` resolves
 * solely in a dev-shaped environment (see `env.ts`); it is structurally absent
 * from staging/production.
 *
 * A token with an `email` claim is an interactive human (the editor); one without
 * is a service principal (Claude / automation), mirroring the Access split.
 */
import { jwtVerify, SignJWT } from "jose";
import type { Principal } from "../router";

const DEV_ISSUER = "kestrel-dev";
const DEV_AUDIENCE = "kestrel-admin";

const keyFor = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/** Sign a dev admin token. Omit `email` for a service (Claude/automation) principal. */
export async function mintDevToken(
  secret: string,
  claims: { email?: string } = {},
  ttl: string = "12h",
): Promise<string> {
  return new SignJWT(claims.email ? { email: claims.email } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keyFor(secret));
}

/** Verify a dev token and map it to a `Principal`. Returns `null` when invalid. */
export async function verifyDevToken(token: string, secret: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, keyFor(secret), {
      issuer: DEV_ISSUER,
      audience: DEV_AUDIENCE,
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return email ? { kind: "human", email } : { kind: "service" };
  } catch {
    return null;
  }
}
