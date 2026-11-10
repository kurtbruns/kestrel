// Finding a time zone by what a publisher types (SPEC §9): its long name ("Eastern Time"), its
// city, today's abbreviation ("EST"), or its offset ("UTC-5"), all read from this browser's
// `Intl`, since Kestrel keeps no table of zones. Pure, so the Settings section and its spec
// share one rule for what matches and how a match is marked.

import { resolveTimeZone, timeZoneLabel } from "../../shared/time_zone";

/** One zone as search shows it. */
export interface ZoneChoice {
  /** The IANA name as this browser lists it, which is what a save sends. */
  zone: string;
  /** Its long name, "Eastern Time". */
  label: string;
  /** Where it is, from its name: "New York · America". */
  place: string;
  /** Its offset now, "UTC-05:00", and today's abbreviation where it has one ("EST"), else "". */
  offset: string;
  abbreviation: string;
  /** Lowercased words a query's words must each start one of. */
  words: string[];
}

// One formatter per zone and kind, kept for the page: there are hundreds of zones.
const FORMATS = new Map<string, Intl.DateTimeFormat>();
function namePart(zone: string, timeZoneName: "longOffset" | "shortOffset" | "short"): string {
  const key = `${zone} ${timeZoneName}`;
  let format = FORMATS.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName });
    FORMATS.set(key, format);
  }
  return format.formatToParts(Date.now()).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** A zone's place, from its name: `America/Argentina/San_Juan` reads "San Juan · America". */
function placeOf(zone: string): string {
  const parts = zone.replace(/_/g, " ").split("/");
  const city = parts[parts.length - 1] ?? zone;
  return parts.length > 1 ? `${city} · ${parts[0]}` : city;
}

/** The words a query matches against: lowercased, split at spaces and punctuation. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,·()/_]+/)
    .filter(Boolean);
}

/** A zone as search shows and matches it. */
export function zoneChoice(zone: string): ZoneChoice {
  const label = timeZoneLabel(zone);
  const offset = namePart(zone, "longOffset").replace(/^GMT/, "UTC") || "UTC";
  const short = namePart(zone, "short");
  // An abbreviation that is only an offset ("GMT+9") is the offset again, not a name.
  const abbreviation = /^GMT/.test(short) ? "" : short;
  const offsetShort = namePart(zone, "shortOffset").toLowerCase();
  const words = [
    ...wordsOf(zone),
    ...wordsOf(label),
    ...wordsOf(abbreviation),
    offset.toLowerCase(),
    offsetShort,
    offsetShort.replace(/^gmt/, "utc"),
  ];
  return { zone, label, place: placeOf(zone), offset, abbreviation, words };
}

/**
 * Every zone this browser knows, plus any of `also` it doesn't list (a saved zone set through
 * the API, or a browser on `UTC`, which reports a zone its own list leaves out). A zone is found
 * in the list by what it resolves to, so an alias of a listed zone is that zone, once.
 */
export function zoneChoices(also: (string | null)[]): ZoneChoice[] {
  const listed =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const extra: string[] = [];
  for (const zone of also) {
    if (zone !== null && listedAs([...extra, ...listed], zone) === null) {
      extra.push(zone);
    }
  }
  return [...extra, ...listed].map(zoneChoice);
}

/** The name `zones` holds `zone` under, matched by what it resolves to, or null. */
export function listedAs(zones: string[], zone: string): string | null {
  const resolved = resolveTimeZone(zone);
  return zones.find((z) => z === zone || z === resolved) ?? null;
}

/** The query's words, as a match reads them. */
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * The zones a query finds: each of its words starts a word of the zone (so "los a" finds Los
 * Angeles and never "Pacific"), a zone whose place or name starts with the query first, then by
 * offset. At most `limit`.
 */
export function searchZones(choices: ZoneChoice[], query: string, limit = 30): ZoneChoice[] {
  const qs = queryWords(query);
  if (qs.length === 0) {
    return [];
  }
  const whole = qs.join(" ");
  const rank = (c: ZoneChoice) =>
    c.place.toLowerCase().startsWith(whole) ? 0 : c.label.toLowerCase().startsWith(whole) ? 1 : 2;
  return choices
    .filter((c) => qs.every((q) => c.words.some((w) => w.startsWith(q))))
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map(({ c }) => c);
}

/**
 * `text` cut into runs, each marked when it is the start of a word a query word begins, by the
 * same rule as `searchZones`, so what is marked is why a zone matched. Worked out on the text as
 * shown, so the marks never land inside markup.
 */
export function markedRuns(text: string, query: string): { text: string; marked: boolean }[] {
  const qs = queryWords(query);
  const marks = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(/[^\s,·()/]+/g)) {
    const word = m[0].toLowerCase();
    const longest = qs.filter((q) => word.startsWith(q)).sort((a, b) => b.length - a.length)[0];
    for (let i = 0; i < (longest?.length ?? 0); i++) {
      marks[(m.index ?? 0) + i] = true;
    }
  }
  const runs: { text: string; marked: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.marked === marks[i]) {
      last.text += text[i];
    } else {
      runs.push({ text: text[i] ?? "", marked: marks[i] ?? false });
    }
  }
  return runs;
}
