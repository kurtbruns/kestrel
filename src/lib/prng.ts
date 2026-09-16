/**
 * A tiny seeded PRNG (mulberry32): one 32-bit seed drives a reproducible stream of
 * floats in [0, 1). Shared by the parametric demo seed (churn timing, suppression
 * victims, per-send failures) and the dev send simulation (edge-state placement,
 * delivery lag), so a given seed reproduces the same shape run to run.
 */

/** The default PRNG seed, so a scale/simulation with no explicit seed is reproducible. */
export const DEFAULT_SEED = 0x5eed;

export function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a string (FNV-1a), for deriving a per-key PRNG seed — e.g.
 *  a deterministic, order-independent stream per (send, recipient). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
