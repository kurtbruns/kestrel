/** Id and token generation. */

/** App-wide unique id (UUID v4). */
export const newId = (): string => crypto.randomUUID();

/** Unguessable hex token (default 32 bytes → 64 hex chars) for confirm/unsubscribe links. */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}
