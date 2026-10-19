/**
 * What a spec needs to call the Worker over HTTP: its origin, an admin's credentials, a JSON
 * reader, and a real image to upload. One copy, so every spec talks to the app the same way.
 *
 * The admin credentials are the same dev-signed token the app verifies, so the suite
 * exercises the real "verify token -> principal" path rather than a stub.
 */
import { CLIENT_HEADER } from "../../shared/who_acted";
import { mintDevToken } from "../../src/auth/dev_token";

/** The origin specs address the Worker at (`SELF.fetch`). */
export const base = "https://kestrel.test";

/** Must match `DEV_AUTH_SECRET` in vitest.config.ts. */
export const DEV_SECRET = "test-dev-secret";

/**
 * Auth headers for admin/authoring requests. Omit `email` for a service principal; `client`
 * is what the request names itself in `Kestrel-Client`, sent only when given. The default is
 * a person in the editor, as the editor sends it.
 */
export async function adminAuth(
  opts: { email?: string; client?: string } = { email: "tester@example.com", client: "editor" },
): Promise<Record<string, string>> {
  const token = await mintDevToken(DEV_SECRET, opts.email ? { email: opts.email } : {});
  return {
    Authorization: `Bearer ${token}`,
    ...(opts.client !== undefined ? { [CLIENT_HEADER]: opts.client } : {}),
  };
}

/** An admin's headers, a person in the editor, minted once per spec file. */
export const AUTH = await adminAuth();

/** An admin's headers for a JSON body. */
export const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

/** A response's JSON body, untyped: a spec asserts on its shape. */
export const readJson = async (r: Response): Promise<any> => r.json();

/** A real 1×1 PNG, for the specs that upload an image. */
export const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);
