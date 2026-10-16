// Pure formatting and parsing, with no DOM: dates, countdowns, the datetime-local value,
// and the recipient list.

import { isValidEmail, normalizeEmail } from "../../shared/email";

/**
 * A short local date-time, or an em dash for none. The year shows only when it isn't the
 * current one (local time), past or future, so this year's dates stay short and a date
 * from another year, such as a send from last year or one scheduled for next January,
 * can't read as this year's.
 */
export function fmt(ms: number | null | undefined): string {
  if (!ms) {
    return "—";
  }
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

/** One address a test didn't reach, and the sentence saying why. */
export interface TestMiss {
  email: string;
  /** The server's words for why (a test response's `not_sent.message`), or the request's
   *  own error; "" when there is nothing to say. */
  message: string;
}

/**
 * The dialog error for a test that didn't reach every address: who got it, why each other
 * address didn't, each distinct reason once with the addresses it covers, and that Send
 * again tries only those. Both test dialogs leave just the failed addresses in their
 * field, so a second press mails no one twice. A reason is the server's own sentence,
 * which says whether sending again can help, so with one the dialog adds no advice of its
 * own, only who Send again goes to.
 */
export function notSentMessage(sent: number, total: number, missed: TestMiss[]): string {
  const byReason = new Map<string, string[]>();
  const unexplained: string[] = [];
  for (const m of missed) {
    if (m.message) {
      byReason.set(m.message, [...(byReason.get(m.message) ?? []), m.email]);
    } else {
      unexplained.push(m.email);
    }
  }
  if (!byReason.size) {
    return sent
      ? `Sent to ${sent} of ${total}. Not sent to ${unexplained.join(", ")}. Send again to try those.`
      : "Not sent. Send again to try.";
  }
  // Name the addresses whenever there was more than one, so each reason says whose it is.
  const reasons = [...byReason].map(([message, emails]) =>
    total > 1 ? `${emails.join(", ")}: ${message}` : message,
  );
  if (unexplained.length) {
    reasons.push(`Not sent to ${unexplained.join(", ")}.`);
  }
  return sent
    ? `Sent to ${sent} of ${total}. ${reasons.join(" ")} Send again goes only to those.`
    : reasons.join(" ");
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
    // queue once something is (docs/DESIGN.md §4).
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
