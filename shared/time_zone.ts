// The publication's time zone as both runtimes read it (SPEC §9): an IANA name, checked,
// labeled, compared, and used to write dates and times, all through the runtime's `Intl`.
// Kestrel keeps no table of zones or names, so what a name means and what it is called are
// the runtime's, and one module serves the Worker and the editor so the two can't disagree.

// What each name resolved to, and each zone's label formatter, kept for the life of the
// isolate or page: building an `Intl.DateTimeFormat` costs tens of microseconds, every settings
// read resolves the stored zone, and the picker labels hundreds. A runtime's zone data is fixed
// while it runs, so neither can go stale; a label is still read at the moment asked for.
const RESOLVED = new Map<string, string>();
const LABEL_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The zone a name resolves to in this runtime, or null when the runtime doesn't know the
 * name. Aliases resolve to one name (`US/Eastern` to `America/New_York`, and in the engine
 * behind Chrome and Workers `Asia/Kolkata` to `Asia/Calcutta`), and case is corrected.
 */
export function resolveTimeZone(name: string): string | null {
  // A bare offset ("-05:00") is a zone to newer runtimes but not a place: it never changes
  // for daylight saving time, so it is no publication's clock.
  if (typeof name !== "string" || name.trim() === "" || /^[+-]/.test(name.trim())) {
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
 */
export function timeZoneLabel(zone: string, at = Date.now()): string {
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
