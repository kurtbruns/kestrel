/** Assert a lookup that must succeed actually did. Used for rows read back
 *  right after writing them, where a `null` means an invariant broke, not a
 *  normal "not found" — so fail loud with a name instead of a bare `!`. */
export function unwrap<T>(value: T | null | undefined, what: string): T {
  if (value == null) {
    throw new Error(`expected ${what} to exist`);
  }
  return value;
}
