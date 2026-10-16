/** Id and token generation. */

/** App-wide unique id (UUID v4). */
export const newId = (): string => crypto.randomUUID();

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

/** Unguessable hex token (default 32 bytes → 64 hex chars) for confirm/unsubscribe links. */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) {
    out += HEX[b];
  }
  return out;
}

/**
 * `n` tokens as `newToken` makes them, from one draw of randomness, for an import that adds
 * thousands of subscribers in one request. `getRandomValues` fills at most 65,536 bytes a
 * call, so a larger draw is taken in parts.
 */
/** A post's unlisted-link token (SPEC §5): 128 random bits as 32 hex digits in four groups of
 *  eight joined by hyphens, so a reader can keep their place in it. The migration's trigger makes
 *  the same shape for a post inserted without one. */
export function newUnlistedToken(): string {
  return newToken(16).replace(/(.{8})(?=.)/g, "$1-");
}

export function newTokens(n: number, bytes = 32): string[] {
  const buf = new Uint8Array(n * bytes);
  for (let at = 0; at < buf.length; at += 65_536) {
    crypto.getRandomValues(buf.subarray(at, Math.min(at + 65_536, buf.length)));
  }
  const out: string[] = new Array(n);
  for (let t = 0; t < n; t++) {
    let s = "";
    for (let k = t * bytes; k < (t + 1) * bytes; k++) {
      s += HEX[buf[k] as number];
    }
    out[t] = s;
  }
  return out;
}
