// The publication's time zone as both runtimes read it (SPEC §9): an IANA name, checked,
// labeled, compared, and used to write dates and times, all through the runtime's `Intl`.
// Kestrel keeps no table of zones or names, so what a name means and what it is called are
// the runtime's, and one module serves the Worker and the editor so the two can't disagree.
// It also reads a local time on a zone's clock (the moment it names, or the clock change that
// leaves it naming none or two) and says how far off a moment is, for a fire time (SPEC §6).

import type { ReadBack } from "./sends";

// What each name resolved to, and each zone's label formatter, kept for the life of the
// isolate or page: building an `Intl.DateTimeFormat` costs tens of microseconds, every settings
// read resolves the stored zone, and the picker labels hundreds. A runtime's zone data is fixed
// while it runs, so neither can go stale; a label is still read at the moment asked for.
const RESOLVED = new Map<string, string>();
const LABEL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A name the runtime resolved that means UTC, however the engine spells it. */
const MEANS_UTC = /^(Etc\/)?(UTC|GMT)$/;

/**
 * Zone names that read like a clock people keep and aren't one: fixed offsets that never
 * change for daylight saving time. "We're on EST" means New York's clock, and a publication
 * set to the zone `EST` would be an hour off all summer with nothing on screen to show it. The
 * list is whole: these are the only fixed offsets the time zone database names like a seasonal
 * abbreviation, kept for old software, and it adds no more.
 */
const NEVER_SEASONAL = ["EST", "MST", "HST"];

/** Whether a name is one of the abbreviations refused for never changing with the seasons. */
export function neverSeasonal(name: string): boolean {
  return NEVER_SEASONAL.includes(name.trim().toUpperCase());
}

/**
 * The zone a name resolves to in this runtime, or null when it is no publication's clock: a
 * name the runtime doesn't know, a bare offset, or an abbreviation that never changes for
 * daylight saving time (`neverSeasonal`). Aliases resolve to one name (`US/Eastern` to
 * `America/New_York`, and in the engine behind Chrome and Workers `Asia/Kolkata` to
 * `Asia/Calcutta`), and case is corrected.
 */
export function resolveTimeZone(name: string): string | null {
  // A bare offset ("-05:00") is a zone to newer runtimes but not a place: like the refused
  // abbreviations, it never changes for daylight saving time.
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    /^[+-]/.test(name.trim()) ||
    neverSeasonal(name)
  ) {
    return null;
  }
  const key = name.trim();
  const known = RESOLVED.get(key);
  if (known !== undefined) {
    return known;
  }
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: key }).resolvedOptions().timeZone;
    RESOLVED.set(key, zone);
    return zone;
  } catch {
    // RangeError: a name the runtime doesn't know. Not kept, so a stream of bad names
    // grows nothing.
    return null;
  }
}

/**
 * Whether two names are the same zone, by what each resolves to and never as strings, since
 * engines disagree about which of a pair of aliases is the canonical one. A name the runtime
 * doesn't know is the same as nothing.
 */
export function sameTimeZone(a: string | null, b: string | null): boolean {
  const ra = a === null ? null : resolveTimeZone(a);
  const rb = b === null ? null : resolveTimeZone(b);
  return ra !== null && ra === rb;
}

/**
 * A zone's name for people: its standard long generic name from the runtime's locale data,
 * "Eastern Time" or "Japan Standard Time", never an abbreviation, and the same in summer and
 * winter. A zone with no such name, such as `Etc/GMT+5`, reads as its offset ("GMT-05:00").
 * UTC is the one name Kestrel gives itself: the runtime has only an offset for it
 * ("GMT+00:00"), and "UTC" is what everyone calls that clock, neither ambiguous nor seasonal
 * as other abbreviations are.
 */
export function timeZoneLabel(zone: string, at = Date.now()): string {
  if (MEANS_UTC.test(zone)) {
    return "UTC";
  }
  // Read at a moment, since a place's zone can change: North Dakota's New Salem was on
  // Mountain Time until 2003.
  let format = LABEL_FORMATS.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" });
    LABEL_FORMATS.set(zone, format);
  }
  const parts = format.formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
}

/**
 * A post's date as a reader sees it, "November 9, 2026": the publication's day, with no zone
 * named, like a newspaper's dateline. With no zone set it is the day in UTC.
 */
export function formatPublicationDate(ms: number, zone: string | null): string {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: zone ?? "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The calendar year of a moment in a zone. */
function yearIn(ms: number, zone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(new Date(ms)),
  );
}

/**
 * The clock time alone of a moment in a zone, "9:00 AM", with no date or zone named: the
 * part of a reading a publisher compares against the time they meant.
 */
export function formatClockTime(ms: number, zone: string): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The day of a moment on a zone's clock, "Fri Nov 13". The year shows only when it isn't that
 * clock's current year at `now`.
 */
export function formatDayInTimeZone(ms: number, zone: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = yearIn(ms, zone) === yearIn(now, zone) ? "" : `, ${part("year")}`;
  return `${part("weekday")} ${part("month")} ${part("day")}${year}`;
}

/**
 * A moment as the publication's clock reads it, with the zone named: "Fri Nov 13, 9:00 AM
 * Eastern Time". The year shows only when it isn't the publication's current year at `now`.
 */
export function formatInTimeZone(ms: number, zone: string, now = Date.now()): string {
  return `${formatDayInTimeZone(ms, zone, now)}, ${formatClockTime(ms, zone)} ${timeZoneLabel(zone)}`;
}

/**
 * What a zone change says about one scheduled send (SPEC §9): it keeps its moment, and this
 * is how that moment now reads. When the send read differently on the old zone's clock, the
 * sentence ends with the time it had there, the one the publisher most likely meant. Several
 * sends are each named by subject.
 */
export function scheduledSendReading(
  send: { subject: string; fire_at: number },
  from: string,
  to: string,
  named: boolean,
  now = Date.now(),
): string {
  const which = named ? `Your scheduled post “${send.subject}”` : "Your scheduled post";
  const reads = `${which} stays at the same moment, now ${formatInTimeZone(send.fire_at, to, now)}.`;
  const before = formatClockTime(send.fire_at, from);
  return before === formatClockTime(send.fire_at, to)
    ? reads
    : `${reads} Move it if you meant ${before}.`;
}

/** The refusal for a zone name the runtime won't take as a publication's clock, naming why:
 *  an abbreviation that never changes for daylight saving time, or a name it doesn't know.
 *  One wording for the setting and for a fire time's `time_zone`. */
export function timeZoneNameRefusal(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name === "") {
    return "The time zone must be an IANA name, such as America/New_York.";
  }
  return neverSeasonal(name)
    ? `${name.toUpperCase()} isn’t a place: it never changes for daylight saving time. Use the place your readers keep, such as America/New_York.`
    : `“${name}” isn’t a time zone this server knows. Use an IANA name, such as America/New_York.`;
}

// --- Local times: a wall clock reading in a zone, and the moment it names (SPEC §6) -------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A local time as a client sends it, `2026-11-13T09:00`, seconds optional: a reading of a
 *  wall clock with no zone in it. */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A wall clock reading, kept as the milliseconds that reading would be in UTC: arithmetic on
 *  it is calendar arithmetic, and formatting it in UTC prints it as it was read. */
export type Wall = number & { readonly __wall: true };

/** The wall clock reading a local time names, or null when it isn't one: the wrong shape, or a
 *  day or hour that doesn't exist on any calendar (February 30, 25:00). */
export function parseLocalTime(text: string): Wall | null {
  const m = LOCAL_TIME.exec(text);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  // Date.UTC rolls an impossible day or hour into the next, so a reading that doesn't round-trip
  // isn't one.
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    return null;
  }
  return wall as Wall;
}

/** A wall clock reading as a local time, `2026-11-13T09:00`, the form both clients send. */
export function formatLocalTime(wall: Wall): string {
  return new Date(wall).toISOString().slice(0, 16);
}

const WALL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** What a zone's wall clock reads at a moment, to the second. */
export function wallAt(ms: number, zone: string): Wall {
  let format = WALL_FORMATS.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    WALL_FORMATS.set(zone, format);
  }
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const p of format.formatToParts(ms)) {
    part[p.type] = Number(p.value);
  }
  return Date.UTC(
    part.year ?? 1970,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    (part.hour ?? 0) % 24,
    part.minute ?? 0,
    part.second ?? 0,
  ) as Wall;
}

/** A zone's offset from UTC at a moment, in milliseconds (New York in winter: -5 hours). */
export function offsetAt(ms: number, zone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAt(whole, zone) - whole;
}

/** A clock change near a wall clock reading: the moment it happens, and what the clock read
 *  just before and just after it. */
export interface ClockChange {
  at: number;
  from: Wall;
  to: Wall;
}

/**
 * What a local time names in a zone: the one moment it reads that, or the clock change that
 * makes it name none (`skipped`, a spring-forward gap) or two (`repeated`, an hour a clock
 * falls back through). Worked out from the zone's own rules on that date, so a 30-minute
 * change or one that skips midnight reads as it is.
 */
export type LocalReading =
  | { kind: "exact"; at: number }
  | { kind: "skipped"; change: ClockChange }
  | { kind: "repeated"; change: ClockChange; earlier: number; later: number };

export function readLocalTime(wall: Wall, zone: string): LocalReading {
  // A zone's offset changes at most once in a couple of days, so the offsets a day either side
  // are the only ones the reading can be on.
  const before = offsetAt(wall - DAY, zone);
  const after = offsetAt(wall + DAY, zone);
  const hits = [...new Set([before, offsetAt(wall, zone), after])]
    .map((offset) => wall - offset)
    .filter((t) => wallAt(t, zone) === wall)
    .sort((a, b) => a - b);
  const [first, ...rest] = [...new Set(hits)];
  if (first !== undefined && rest.length === 0) {
    return { kind: "exact", at: first };
  }
  const change = clockChangeBetween(wall - DAY - Math.abs(before), wall + DAY, zone);
  if (first === undefined) {
    return { kind: "skipped", change };
  }
  return { kind: "repeated", change, earlier: first, later: rest[rest.length - 1] ?? first };
}

/** The clock change between two moments the zone reads on different offsets, found to the
 *  second by halving: the last moment on the first offset, and the first on the next. */
function clockChangeBetween(lo: number, hi: number, zone: string): ClockChange {
  const start = offsetAt(lo, zone);
  let a = Math.floor(lo / 1000);
  let b = Math.ceil(hi / 1000);
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (offsetAt(mid * 1000, zone) === start) {
      a = mid;
    } else {
      b = mid;
    }
  }
  const at = b * 1000;
  return { at, from: (at + start) as Wall, to: (at + offsetAt(at, zone)) as Wall };
}

/** A wall clock reading's time of day, "9:00 AM". */
function clockOf(wall: Wall): string {
  return formatClockTime(wall, "UTC");
}

/** Two times of day as a range, "2:00 to 3:00 AM", naming AM or PM once when they share it. */
function clockRange(from: Wall, to: Wall): string {
  const a = clockOf(from);
  const b = clockOf(to);
  const half = a.slice(-3);
  return half === b.slice(-3) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}

/** A wall clock reading's day, "Sun Mar 14", with the year when it isn't the zone's year now. */
function dayOf(wall: Wall, zone: string, now: number): string {
  const year = new Date(wall).getUTCFullYear();
  const shown = year === new Date(wallAt(now, zone)).getUTCFullYear() ? "" : `, ${year}`;
  const text = new Date(wall).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${text.replace(",", "")}${shown}`;
}

/**
 * Why a local time names no moment, or two, in words fit to show the publisher: the time, the
 * day, the zone, the change itself as the zone's rules have it, and which times to pick instead.
 * Null when it names exactly one.
 */
export function localTimeRefusal(wall: Wall, zone: string, now = Date.now()): string | null {
  const reading = readLocalTime(wall, zone);
  if (reading.kind === "exact") {
    return null;
  }
  const { change } = reading;
  const where = `on ${dayOf(wall, zone, now)} in ${timeZoneLabel(zone, change.at)}`;
  if (reading.kind === "skipped") {
    const before = isMidnight(change.from) ? "" : `before ${clockOf(change.from)} or `;
    return `${clockOf(wall)} doesn’t happen ${where}: clocks jump from ${clockRange(change.from, change.to)}. Pick a time ${before}from ${clockOf(change.to)}.`;
  }
  return `${clockOf(wall)} happens twice ${where}: clocks go back from ${clockRange(change.from, change.to)}. Pick a time before ${clockOf(change.to)} or from ${clockOf(change.from)}.`;
}

function isMidnight(wall: Wall): boolean {
  return wall % DAY === 0;
}

// --- How far off a moment is, and how a send reads back (SPEC §6) ------------------------

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The moment a zone's clock reads `wall`, or for a reading a clock change skips or repeats,
 *  the earliest moment at or after it: what "the same time, n days on" lands on. */
function momentOf(wall: Wall, zone: string): number {
  const reading = readLocalTime(wall, zone);
  if (reading.kind === "exact") {
    return reading.at;
  }
  return reading.kind === "repeated" ? reading.earlier : reading.change.at;
}

/**
 * How far off a moment is, in whole units, rounded down so it never reads later than it is:
 * whole calendar days on the zone's clock (so "in 1 day" is the same time tomorrow there, across
 * a clock change too) and the hours after them, or under a day the hours and minutes. `days` is
 * 0 under a day.
 */
export function timeUntil(
  ms: number,
  zone: string,
  now = Date.now(),
): { days: number; hours: number; minutes: number } {
  const left = Math.max(0, ms - now);
  if (left >= DAY) {
    const start = wallAt(now, zone);
    let days = Math.floor((wallAt(ms, zone) - start) / DAY);
    while (days > 0 && momentOf((start + days * DAY) as Wall, zone) > ms) {
      days--;
    }
    if (days > 0) {
      const rest = ms - momentOf((start + days * DAY) as Wall, zone);
      return { days, hours: Math.floor(rest / HOUR), minutes: Math.floor((rest % HOUR) / MINUTE) };
    }
  }
  return { days: 0, hours: Math.floor(left / HOUR), minutes: Math.floor((left % HOUR) / MINUTE) };
}

/** A span `timeUntil` measured, in words: "2 days, 7 hours", "1 hour, 19 minutes", "59 minutes". */
function spanWords({ days, hours, minutes }: ReturnType<typeof timeUntil>): string {
  if (days > 0) {
    return `${plural(days, "day")}${hours > 0 ? `, ${plural(hours, "hour")}` : ""}`;
  }
  if (hours > 0) {
    return `${plural(hours, "hour")}${minutes > 0 ? `, ${plural(minutes, "minute")}` : ""}`;
  }
  return minutes > 0 ? plural(minutes, "minute") : "less than a minute";
}

/**
 * How long until a moment, in words: "in 2 days, 7 hours", "in 1 hour, 19 minutes", "in 59
 * minutes" (`timeUntil`, rounded down). A moment already reached reads "now".
 */
export function formatTimeUntil(ms: number, zone: string, now = Date.now()): string {
  return ms <= now ? "now" : `in ${spanWords(timeUntil(ms, zone, now))}`;
}

/**
 * How long something has gone on since a moment, in words, measured as `timeUntil` measures
 * ahead and so rounded down, never reading longer than it has been: "2 hours", "1 day, 3
 * hours", "less than a minute". What a notification leads with when its point is an age.
 */
export function formatTimeSince(ms: number, zone: string, now = Date.now()): string {
  return spanWords(timeUntil(now, zone, Math.min(ms, now)));
}

/**
 * How a send's fire time reads, beside an answer that names it (SPEC §6): on the publication's
 * clock with its zone named, how far off it is, and the publication's time now, for a client to
 * relay as it stands. With no zone set, in UTC.
 */
export function readBack(fireAt: number, zone: string | null, now = Date.now()): ReadBack {
  const clock = zone ?? "UTC";
  return {
    fire_at_local: formatInTimeZone(fireAt, clock, now),
    fire_at_in: formatTimeUntil(fireAt, clock, now),
    now_local: formatInTimeZone(now, clock, now),
  };
}

/**
 * A moment on someone else's clock, said so: "Fri 11:00 PM your time · Japan Standard Time".
 * Always the weekday, so it never has to be read against a date beside it, and always the zone,
 * so a clock set to the wrong zone shows up wherever this does.
 */
export function formatSecondClock(ms: number, zone: string): string {
  const day = new Date(ms).toLocaleDateString("en-US", { timeZone: zone, weekday: "short" });
  return `${day} ${formatClockTime(ms, zone)} your time · ${timeZoneLabel(zone, ms)}`;
}

/** Whether two zones' clocks read differently at any of the moments given (never by name). */
export function clocksDiffer(a: string, b: string, moments: number[]): boolean {
  return moments.some((t) => offsetAt(t, a) !== offsetAt(t, b));
}
