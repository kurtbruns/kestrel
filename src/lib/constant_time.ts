/**
 * Constant-time string comparison for secrets (bearer tokens, signatures).
 *
 * Uses Web Crypto HMAC over both inputs with a fresh random key, then compares
 * the fixed-length digests. This is timing-safe and independent of input length,
 * so it never leaks how many leading characters matched — unlike a naive `===`.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])) as CryptoKey;
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}
