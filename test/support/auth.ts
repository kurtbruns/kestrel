/**
 * Test admin credentials: mint the same dev-signed token the app verifies, so the
 * suite exercises the real "verify token -> principal" path rather than a stub.
 */
import { mintDevToken } from "../../src/auth/dev_token";

/** Must match `DEV_AUTH_SECRET` in vitest.config.ts. */
export const DEV_SECRET = "test-dev-secret";

/** Auth header for admin/authoring requests. Omit `email` for a service principal. */
export async function adminAuth(
  opts: { email?: string } = { email: "tester@example.com" },
): Promise<Record<string, string>> {
  const token = await mintDevToken(DEV_SECRET, opts.email ? { email: opts.email } : {});
  return { Authorization: `Bearer ${token}` };
}
