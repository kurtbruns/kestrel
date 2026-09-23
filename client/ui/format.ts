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
 * addresses, dropping any the server would refuse. Server-side validation is still
 * authoritative; this just tidies the Send-test input.
 */
export function parseAddresses(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of String(text || "").split(/[\n,]+/)) {
    const a = normalizeEmail(part);
    if (isValidEmail(a)) {
      out.add(a);
    }
  }
  return [...out];
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
export function untilStr(fireAt: number): string {
  const d = fireAt - Date.now();
  if (d <= 0) {
    return "Sending now…";
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
