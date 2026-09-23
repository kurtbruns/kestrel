// What a valid email address is, spelled once for the Worker and the editor, so a form
// never accepts an address the API will refuse, or refuses one it would take.

/** The form an address is stored and compared in: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A plausible address: one `@`, something before it, and a dotted domain after it, with
 * no whitespace. Deliberately loose: the confirmation email is the real check (SPEC §7).
 * Pass it a normalized address.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
