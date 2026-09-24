// Pure formatting and parsing, with no DOM: dates, countdowns, the datetime-local value,
// and the recipient list.

import { isValidEmail, normalizeEmail } from "../../shared/email";

/** A short local date-time, or an em dash for none. */
export const fmt = (ms: number | null | undefined): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

/**
 * Split a free-text recipient list (newlines or commas) into unique, normalized
 * addresses, and the entries that aren't addresses, as typed, so the caller can name
 * them instead of quietly sending to fewer people than were listed. Server-side
 * validation is still authoritative; this tidies the Send-test input.
 */
export function parseAddresses(text: string | null | undefined): {
  valid: string[];
  invalid: string[];
} {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const part of String(text || "").split(/[\n,]+/)) {
    const a = normalizeEmail(part);
    if (isValidEmail(a)) {
      valid.add(a);
    } else if (a) {
      invalid.push(part.trim());
    }
  }
  return { valid: [...valid], invalid };
}

/** The toast for Send-test entries that aren't addresses, or null when there are none. */
export function invalidAddressesMessage(invalid: string[]): string | null {
  if (!invalid.length) {
    return null;
  }
  return `Not ${invalid.length === 1 ? "an email address" : "email addresses"}: ${invalid.join(", ")}`;
}

/** A Date as the value of a `datetime-local` input, in local time. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A countdown that gets coarser the further out the fire time is: it ticks seconds
 * only inside the last few minutes (the imminent / send-now cancel window), then
 * counts down by the minute, by the hour within a day, and by whole days beyond, so
 * a send scheduled days away reads "Sends in 2 days", not a ticking "47h 47m".
 */
export function untilStr(fireAt: number, due = false): string {
  const d = fireAt - Date.now();
  if (due || d <= 0) {
    // From the fire time the send waits for the sweep's tick on that minute (a fire time is
    // on the minute, SPEC §6), a few seconds; nothing is sending yet, and the card leaves the
    // queue once something is (docs/DESIGN.md §9).
    return "Preparing to send…";
  }
  const s = Math.floor(d / 1000);
  const min = Math.floor(s / 60);
  const hr = Math.floor(min / 60);
  if (s < 300) {
    return min > 0 ? `Sends in ${min}m ${String(s % 60).padStart(2, "0")}s` : `Sends in ${s}s`;
  }
  if (min < 60) {
    return `Sends in ${min}m`;
  }
  if (hr < 24) {
    const rm = min % 60;
    return rm > 0 ? `Sends in ${hr}h ${rm}m` : `Sends in ${hr}h`;
  }
  const days = Math.round(hr / 24);
  return `Sends in ${days} day${days === 1 ? "" : "s"}`;
}

/** A scheduled send past the server's missed tolerance, by how late it now is. */
export function lateStr(fireAt: number): string {
  const min = Math.max(0, Math.floor((Date.now() - fireAt) / 60_000));
  return `Missed its fire time · ${min} min late`;
}
