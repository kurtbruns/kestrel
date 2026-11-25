/**
 * A Cloudflare Access deployment whose team serves a key the spec holds, so a request can carry
 * an assertion the app verifies for real (`Cf-Access-Jwt-Assertion`), as Access forwards one for
 * a browser sign-in, a service token, or a program signed in through managed OAuth.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

/**
 * The deploy vars for a team of its own, and a way to sign its assertions. A team domain of its
 * own per call, since the app caches a team's keys for the life of the isolate. `stored` is the
 * team domain as the operator entered it, which may carry a scheme or a trailing slash. Stubs
 * `fetch` for the team's keys, so the spec restores mocks in its `afterEach`. An assertion's
 * `as` overrides what Access would have signed (its issuer, audience, key id, or its expiry or
 * start time in seconds since the epoch), for a spec of a token the app must refuse.
 */
export async function accessDeployment(stored: (team: string) => string = (team) => team) {
  const team = `team-${crypto.randomUUID()}.cloudflareaccess.com`;
  const vars = { ACCESS_TEAM_DOMAIN: stored(team), ACCESS_AUD: "aud-tag" };
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://${team}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    return realFetch(input, init);
  });
  const assertion = async (
    claims: { email?: string; common_name?: string },
    as: {
      issuer?: string;
      audience?: string;
      kid?: string;
      expires?: number;
      notBefore?: number;
    } = {},
  ) => ({
    "Cf-Access-Jwt-Assertion": await new SignJWT(
      as.notBefore === undefined ? claims : { ...claims, nbf: as.notBefore },
    )
      .setProtectedHeader({ alg: "RS256", kid: as.kid ?? "k1" })
      .setIssuer(as.issuer ?? `https://${team}`)
      .setAudience(as.audience ?? "aud-tag")
      .setIssuedAt()
      .setExpirationTime(as.expires ?? "5m")
      .sign(privateKey),
  });
  return { vars, assertion };
}
