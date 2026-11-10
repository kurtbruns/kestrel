import { describe, expect, it } from "vitest";
import {
  formatDayInTimeZone,
  formatInTimeZone,
  formatPublicationDate,
  resolveTimeZone,
  sameTimeZone,
  scheduledSendReading,
  timeZoneLabel,
} from "./time_zone";

// SPEC §9: the publication's zone, read through the runtime's Intl, the same in both runtimes.

// Fri Nov 14, 2025, 9:00 AM in New York (EST, UTC-5). `now` is passed beside it, so whether
// the year shows never depends on today's date.
const NINE_AM_NEW_YORK = Date.UTC(2025, 10, 14, 14, 0);
const SAME_YEAR = Date.UTC(2025, 10, 1);

describe("a zone's name", () => {
  it("resolves aliases and case to one zone, and refuses what isn't a zone or is a bare offset", () => {
    expect(resolveTimeZone("US/Eastern")).toBe("America/New_York");
    expect(resolveTimeZone("america/new_york")).toBe("America/New_York");
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBeNull();
    expect(resolveTimeZone("")).toBeNull();
    expect(resolveTimeZone("-05:00")).toBeNull();
    expect(resolveTimeZone("+09:00")).toBeNull();
    expect(resolveTimeZone("Etc/GMT+5")).toBe("Etc/GMT+5");
  });

  it("takes a place's name or UTC, and refuses a one-word name that only reads like a clock", () => {
    // Fixed offsets under seasonal-sounding names, and the other one-word names with them.
    for (const name of ["EST", "MST", "HST", "Japan", "est"]) {
      expect(resolveTimeZone(name), name).toBeNull();
    }
    for (const utc of ["UTC", "utc", "GMT", "Etc/UTC"]) {
      expect(resolveTimeZone(utc), utc).toBe("UTC");
    }
  });

  it("compares by zone, never as strings", () => {
    expect(sameTimeZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameTimeZone("US/Eastern", "America/New_York")).toBe(true);
    // Same offset all year round, different zones.
    expect(sameTimeZone("America/Detroit", "America/New_York")).toBe(false);
    expect(sameTimeZone(null, "America/New_York")).toBe(false);
    expect(sameTimeZone("Mars/Olympus_Mons", "Mars/Olympus_Mons")).toBe(false);
  });

  it("is labeled with its long generic name, the same in summer and winter", () => {
    expect(timeZoneLabel("America/New_York")).toBe("Eastern Time");
    expect(timeZoneLabel("Asia/Tokyo")).toBe("Japan Standard Time");
    expect(timeZoneLabel("Asia/Calcutta")).toBe("India Standard Time");
    expect(timeZoneLabel("America/North_Dakota/New_Salem")).toBe("Central Time");
    // UTC is called UTC; any other zone with no generic name reads as its offset.
    expect(timeZoneLabel("UTC")).toBe("UTC");
    expect(timeZoneLabel("Etc/GMT+5")).toBe("GMT-05:00");
  });
});

describe("dates and times in the publication's zone", () => {
  it("dates a post by the publication's day, and by UTC's with no zone", () => {
    // 8 PM in New York is already the next day in UTC.
    const evening = Date.UTC(2025, 10, 15, 1, 0);
    expect(formatPublicationDate(evening, "America/New_York")).toBe("November 14, 2025");
    expect(formatPublicationDate(evening, null)).toBe("November 15, 2025");
  });

  it("writes a day on the zone's clock, the year only when it isn't this year", () => {
    expect(formatDayInTimeZone(NINE_AM_NEW_YORK, "America/New_York", SAME_YEAR)).toBe("Fri Nov 14");
    // 9:00 AM in New York is already 11:00 PM in Tokyo, the same day; 2:00 PM in Auckland is the next.
    expect(formatDayInTimeZone(NINE_AM_NEW_YORK, "Pacific/Auckland", SAME_YEAR)).toBe("Sat Nov 15");
    expect(formatDayInTimeZone(NINE_AM_NEW_YORK, "America/New_York", Date.UTC(2024, 0, 1))).toBe(
      "Fri Nov 14, 2025",
    );
  });

  it("reads a moment on the zone's clock with the zone named, the year only when it isn't this year", () => {
    expect(formatInTimeZone(NINE_AM_NEW_YORK, "America/New_York", SAME_YEAR)).toBe(
      "Fri Nov 14, 9:00 AM Eastern Time",
    );
    expect(formatInTimeZone(NINE_AM_NEW_YORK, "Asia/Tokyo", SAME_YEAR)).toBe(
      "Fri Nov 14, 11:00 PM Japan Standard Time",
    );
    expect(formatInTimeZone(NINE_AM_NEW_YORK, "America/New_York", Date.UTC(2024, 0, 1))).toBe(
      "Fri Nov 14, 2025, 9:00 AM Eastern Time",
    );
  });

  it("says how a scheduled send reads after a zone change, and the time it had before", () => {
    const send = { subject: "Owls", fire_at: NINE_AM_NEW_YORK };
    expect(
      scheduledSendReading(send, "America/New_York", "America/Chicago", false, SAME_YEAR),
    ).toBe(
      "Your scheduled post stays at the same moment, now Fri Nov 14, 8:00 AM Central Time. Move it if you meant 9:00 AM.",
    );
    // Several are each named; a zone that reads the same clock time asks nothing.
    expect(scheduledSendReading(send, "America/Detroit", "America/New_York", true, SAME_YEAR)).toBe(
      "Your scheduled post “Owls” stays at the same moment, now Fri Nov 14, 9:00 AM Eastern Time.",
    );
  });
});
