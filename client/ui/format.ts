// Pure formatting and parsing, with no DOM: dates and times on a given clock, countdowns, the
// datetime-local value, the recipient list, and a send's recipient count.

import { isValidEmail, normalizeEmail } from "../../shared/email";
import {
  formatClockTime,
  formatLocalTime,
  formatSecondClock,
  formatTimeUntil,
  timeUntil,
  wallAt,
} from "../../shared/time_zone";

/** A send's audience in words, which reads "1 recipient" on a list of one (DESIGN's copy rules). */
export function recipientCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "recipient" : "recipients"}`;
}

/**
 * The clocks a screen shows its times on (SPEC §6, DESIGN §10): the publication's (`home`, the
 * browser's while none is set), the browser's, and whether they read differently at any time the
 * screen shows (`away`), with the publication's zone named for people (`label`). A screen decides
 * `away` once for all its times, so it labels every time or none. Passed in, since this module
 * reads no app state.
 */
export interface Clocks {
  home: string;
  browser: string;
  away: boolean;
  label: string;
}

// Each zone's date formatter, with and without the weekday, kept for the life of the page as
// shared/time_zone.ts keeps its own: building one costs tens of microseconds, and a list formats
// a time per row.
const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The parts of a moment on a clock, en-US, as every time in the dashboard is written. */
function partsOn(ms: number, zone: string, weekday: boolean) {
  const key = `${zone} ${weekday}`;
  let format = DAY_FORMATS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: weekday ? "short" : undefined,
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    DAY_FORMATS.set(key, format);
  }
  const parts = format.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: part("weekday"), month: part("month"), day: part("day"), year: part("year") };
}

/**
 * A date and time on the publication's clock, "Nov 13, 9:00 AM", or an em dash for none, with no
 * zone named: the screen names it, in a header or after the time, when the browser's clock
 * differs. The year shows only when it isn't the publication's current year, past or future, so
 * this year's dates stay short and another year's can't read as this one. With `weekday`, a time
 * still to come: "Fri Nov 13, 9:00 AM".
 */
export function fmt(ms: number | null | undefined, c: Clocks, weekday = false): string {
  if (!ms) {
    return "—";
  }
  const p = partsOn(ms, c.home, weekday);
  const year =
    new Date(wallAt(ms, c.home)).getUTCFullYear() ===
    new Date(wallAt(Date.now(), c.home)).getUTCFullYear()
      ? ""
      : `, ${p.year}`;
  const day = `${weekday ? `${p.weekday} ` : ""}${p.month} ${p.day}${year}`;
  return `${day}, ${formatClockTime(ms, c.home)}`;
}

/** A time standing on its own (in a card, a sentence, a label-and-value row), with the
 *  publication's zone after it when the browser's clock differs: "Nov 11, 1:40 AM Eastern Time". */
export function fmtAt(ms: number | null | undefined, c: Clocks, weekday = false): string {
  const at = fmt(ms, c, weekday);
  return c.away && ms ? `${at} ${c.label}` : at;
}

/** A list's column or section header, naming the zone once for every time under it when the
 *  browser's clock differs: "When · Eastern Time". */
export function zoneHeader(word: string, c: Clocks): string {
  return c.away ? `${word} · ${c.label}` : word;
}

/** A time that can still be acted on, on the browser's clock as a second line, or null at home:
 *  "Fri 11:00 PM your time · Japan Standard Time". */
export function secondClock(ms: number, c: Clocks): string | null {
  return c.away ? formatSecondClock(ms, c.browser) : null;
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

/** A moment as the value of a `datetime-local` input on a zone's clock: the picker reads and
 *  writes the publication's time, never the device's. */
export function toLocalInput(ms: number, zone: string): string {
  return formatLocalTime(wallAt(ms, zone));
}

/**
 * A countdown that gets coarser the further out the fire time is: it ticks seconds only inside
 * the last few minutes (the imminent / send-now cancel window), then counts down by the minute,
 * by the hour within a day, by days and hours under three days, and by whole days beyond, so a
 * send three days away reads "Sends in 3 days", not a ticking "71h 47m". Days are calendar days
 * on the publication's clock, rounded down, as the server's `fire_at_in` counts them.
 */
export function untilStr(fireAt: number, zone: string, due = false): string {
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
  const { days } = timeUntil(fireAt, zone);
  if (days >= 3) {
    return `Sends in ${days} days`;
  }
  return `Sends ${formatTimeUntil(fireAt, zone)}`;
}

/** A scheduled send past the server's missed tolerance, by how late it now is. */
export function lateStr(fireAt: number): string {
  const min = Math.max(0, Math.floor((Date.now() - fireAt) / 60_000));
  return `Missed its fire time · ${min} min late`;
}
