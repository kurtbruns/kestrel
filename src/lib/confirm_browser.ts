/**
 * The cookie that binds a confirmation link to the browser that asked for it (SPEC §7). The
 * subscribe form gives every submission a fresh random value, the confirmation that goes out
 * is armed with its SHA-256, and `GET /confirm` confirms at once only when the browser sends
 * back the value whose hash the link carries. The reader surface's one cookie: HttpOnly so no
 * script reads it, `Path=/confirm` so it goes nowhere else, and lasting as long as a link does.
 * Every response that sets or clears it is `no-store`, so no cache keeps or replays it.
 */

import { newToken } from "./ids";
import { CONFIRM_LINK_TTL_MS } from "./time";

const NAME = "kestrel_confirm";
const ATTRIBUTES = "Path=/confirm; HttpOnly; Secure; SameSite=Lax";

/** A fresh value for one submission of the subscribe form. Random, so it says nothing about
 *  the address or the list. */
export function newConfirmBrowserValue(): string {
  return newToken(32);
}

/** The `Set-Cookie` that gives this browser `value`. */
export function setConfirmBrowserCookie(value: string): string {
  return `${NAME}=${value}; Max-Age=${Math.floor(CONFIRM_LINK_TTL_MS / 1000)}; ${ATTRIBUTES}`;
}

/** The `Set-Cookie` that clears it, once the link it bound has confirmed. */
export const CLEAR_CONFIRM_BROWSER_COOKIE = `${NAME}=; Max-Age=0; ${ATTRIBUTES}`;

/** The value this request's browser holds, or null when it sent none. Only a value of the
 *  shape this module makes is read, so nothing else a browser sends is hashed or compared. */
export function readConfirmBrowserCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === NAME) {
      const value = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** What the database keeps of a value: its SHA-256, in hex, never the value itself. */
export async function confirmBrowserHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
