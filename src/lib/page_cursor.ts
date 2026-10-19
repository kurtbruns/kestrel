/**
 * The cursor a keyed page hands back as `next` (docs/API.md, principle 8): where the page
 * ended, as base64url JSON with a version, so a log doesn't show what it holds at a glance.
 * Opaque to clients (it isn't a secret; every paged route is admin-only), and one that
 * doesn't decode is refused by its route, never guessed at.
 */

/** A page's end as a cursor. */
export function encodePageCursor(fields: Record<string, string | number>): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, ...fields }));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The fields a cursor this server issued holds, or null when it isn't one. The route checks
 *  each field's type, since a decoded cursor is still what the client sent. */
export function decodePageCursor(raw: string): Record<string, unknown> | null {
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const fields = value as Record<string, unknown>;
    return fields.v === 1 ? fields : null;
  } catch {
    return null;
  }
}
