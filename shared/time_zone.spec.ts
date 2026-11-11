import { describe, expect, it } from "vitest";
import {
  clocksDiffer,
  formatDayInTimeZone,
  formatInTimeZone,
  formatLocalTime,
  formatPublicationDate,
  formatSecondClock,
  formatTimeSince,
  formatTimeUntil,
  localTimeRefusal,
  parseLocalTime,
  readBack,
  readLocalTime,
  resolveTimeZone,
  sameTimeZone,
  scheduledSendReading,
  timeZoneLabel,
  timeZoneNameRefusal,
  type Wall,
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

  it("refuses the abbreviations that never change for daylight saving time, and nothing else the runtime knows", () => {
    for (const name of ["EST", "MST", "HST", "est", " Hst "]) {
      expect(resolveTimeZone(name), name).toBeNull();
    }
    // Other old one-word names are aliases of real places, and seasonal ones keep their rules.
    expect(resolveTimeZone("Japan")).toBe("Asia/Tokyo");
    expect(resolveTimeZone("EST5EDT")).not.toBeNull();
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

// SPEC §6: a local time is read on a zone's clock, and one a clock change skips or repeats is
// refused with the change as the zone's rules have it.
describe("a local time on a zone's clock", () => {
  const wall = (text: string): Wall => {
    const w = parseLocalTime(text);
    if (w === null) {
      throw new Error(text);
    }
    return w;
  };
  // In 2027, so the year shows against "now" in 2026.
  const NOW = Date.UTC(2026, 10, 10, 15, 0);

  it("takes a local time to the minute, seconds optional, and nothing else", () => {
    expect(formatLocalTime(wall("2026-11-13T09:00"))).toBe("2026-11-13T09:00");
    expect(parseLocalTime("2026-11-13T09:00:30")).toBe(Date.UTC(2026, 10, 13, 9, 0, 30));
    for (const bad of [
      "2026-11-13",
      "2026-11-13 09:00",
      "2026-11-13T9:00",
      "2026-02-30T09:00",
      "2026-11-13T24:00",
      "2026-11-13T09:00Z",
      "2026-11-13T09:00-05:00",
      "2026-11-13T09:00:00.000",
    ]) {
      expect(parseLocalTime(bad), bad).toBeNull();
    }
  });

  it("reads a local time as the moment that zone's clock shows it, on that date's offset", () => {
    expect(readLocalTime(wall("2026-11-13T09:00"), "America/New_York")).toEqual({
      kind: "exact",
      at: Date.UTC(2026, 10, 13, 14, 0),
    });
    // In summer New York is four hours behind, not the five of today's offset.
    expect(readLocalTime(wall("2027-03-20T09:00"), "America/New_York")).toEqual({
      kind: "exact",
      at: Date.UTC(2027, 2, 20, 13, 0),
    });
    expect(readLocalTime(wall("2026-11-13T09:00"), "Australia/Sydney")).toEqual({
      kind: "exact",
      at: Date.UTC(2026, 10, 12, 22, 0),
    });
  });

  it("refuses a time a clock change skips, saying the change it falls in", () => {
    expect(localTimeRefusal(wall("2027-03-14T02:30"), "America/New_York", NOW)).toBe(
      "2:30 AM doesn’t happen on Sun Mar 14, 2027 in Eastern Time: clocks jump from 2:00 to 3:00 AM. Pick a time before 2:00 AM or from 3:00 AM.",
    );
  });

  it("refuses a time a clock change repeats, saying the hour it happens twice in", () => {
    expect(localTimeRefusal(wall("2026-11-01T01:30"), "America/New_York", NOW)).toBe(
      "1:30 AM happens twice on Sun Nov 1 in Eastern Time: clocks go back from 2:00 to 1:00 AM. Pick a time before 1:00 AM or from 2:00 AM.",
    );
  });

  it("works the message out from the zone's own change: a half hour, and one that skips midnight", () => {
    // Lord Howe Island moves its clocks by 30 minutes, at 2:00 AM.
    expect(localTimeRefusal(wall("2026-10-04T02:15"), "Australia/Lord_Howe", NOW)).toBe(
      "2:15 AM doesn’t happen on Sun Oct 4 in Lord Howe Time: clocks jump from 2:00 to 2:30 AM. Pick a time before 2:00 AM or from 2:30 AM.",
    );
    // Santiago springs forward at midnight, so the day starts at 1:00 AM.
    const midnight = localTimeRefusal(wall("2026-09-06T00:30"), "America/Santiago", NOW);
    expect(midnight).toMatch(
      /^12:30 AM doesn’t happen on Sun Sep 6 in .+: clocks jump from 12:00 to 1:00 AM\. Pick a time from 1:00 AM\.$/,
    );
  });

  it("has nothing to refuse for a time that happens once", () => {
    expect(localTimeRefusal(wall("2027-03-14T03:00"), "America/New_York", NOW)).toBeNull();
    expect(localTimeRefusal(wall("2026-11-01T02:00"), "America/New_York", NOW)).toBeNull();
  });
});

describe("how far off a fire time is", () => {
  const NOW = Date.UTC(2026, 10, 11, 7, 0); // Wed Nov 11, 2:00 AM in New York

  it("reads days and hours, rounded down, and under a day hours and minutes", () => {
    const fire = Date.UTC(2026, 10, 13, 14, 0); // Fri 9:00 AM
    expect(formatTimeUntil(fire, "America/New_York", NOW)).toBe("in 2 days, 7 hours");
    expect(formatTimeUntil(NOW + 59 * 60_000 + 59_000, "America/New_York", NOW)).toBe(
      "in 59 minutes",
    );
    expect(formatTimeUntil(NOW + 79 * 60_000, "America/New_York", NOW)).toBe(
      "in 1 hour, 19 minutes",
    );
    expect(formatTimeUntil(NOW + 3 * 3600_000, "America/New_York", NOW)).toBe("in 3 hours");
    expect(formatTimeUntil(NOW + 24 * 3600_000, "America/New_York", NOW)).toBe("in 1 day");
    expect(formatTimeUntil(NOW + 30_000, "America/New_York", NOW)).toBe("in less than a minute");
    expect(formatTimeUntil(NOW, "America/New_York", NOW)).toBe("now");
  });

  it("counts calendar days on the zone's clock, so the same time a day on is one day across a clock change", () => {
    const sat = Date.UTC(2026, 9, 31, 13, 0); // Sat Oct 31, 9:00 AM EDT
    const sun = Date.UTC(2026, 10, 1, 14, 0); // Sun Nov 1, 9:00 AM EST: 25 hours later
    expect(formatTimeUntil(sun, "America/New_York", sat)).toBe("in 1 day");
    expect(formatTimeUntil(sun - 60_000, "America/New_York", sat)).toBe("in 24 hours, 59 minutes");
  });

  it("reads how long something has gone on the same way, rounded down, and never as less than nothing", () => {
    const sat = Date.UTC(2026, 9, 31, 13, 0); // Sat Oct 31, 9:00 AM EDT
    const sun = Date.UTC(2026, 10, 1, 14, 0); // Sun Nov 1, 9:00 AM EST: 25 hours later
    expect(formatTimeSince(sat, "America/New_York", sun)).toBe("1 day");
    expect(formatTimeSince(sat, "America/New_York", sun - 60_000)).toBe("24 hours, 59 minutes");
    expect(formatTimeSince(NOW - 79 * 60_000 - 59_000, "America/New_York", NOW)).toBe(
      "1 hour, 19 minutes",
    );
    expect(formatTimeSince(NOW - 30_000, "America/New_York", NOW)).toBe("less than a minute");
    expect(formatTimeSince(NOW + 60_000, "America/New_York", NOW)).toBe("less than a minute");
  });

  it("reads back a fire time on the publication's clock, and in UTC with no zone", () => {
    const fire = Date.UTC(2026, 10, 13, 14, 0);
    expect(readBack(fire, "America/New_York", NOW)).toEqual({
      fire_at_local: "Fri Nov 13, 9:00 AM Eastern Time",
      fire_at_in: "in 2 days, 7 hours",
      now_local: "Wed Nov 11, 2:00 AM Eastern Time",
    });
    expect(readBack(fire, null, NOW).fire_at_local).toBe("Fri Nov 13, 2:00 PM UTC");
  });
});

describe("a second clock", () => {
  it("names the weekday and the zone every time", () => {
    expect(formatSecondClock(Date.UTC(2026, 10, 13, 14, 0), "Asia/Tokyo")).toBe(
      "Fri 11:00 PM your time · Japan Standard Time",
    );
  });

  it("is needed only when the two clocks read differently at a time shown, not when the names differ", () => {
    const winter = Date.UTC(2026, 11, 1, 12, 0);
    const summer = Date.UTC(2026, 6, 1, 12, 0);
    expect(clocksDiffer("America/New_York", "America/Detroit", [winter, summer])).toBe(false);
    // Phoenix keeps Denver's clock in winter only.
    expect(clocksDiffer("America/Denver", "America/Phoenix", [winter])).toBe(false);
    expect(clocksDiffer("America/Denver", "America/Phoenix", [winter, summer])).toBe(true);
  });
});

describe("a time zone name refused", () => {
  it("says why, in one wording for the setting and a fire time", () => {
    expect(timeZoneNameRefusal("est")).toMatch(/^EST isn’t a place/);
    expect(timeZoneNameRefusal("Mars/Base")).toBe(
      "“Mars/Base” isn’t a time zone this server knows. Use an IANA name, such as America/New_York.",
    );
    expect(timeZoneNameRefusal("")).toMatch(/must be an IANA name/);
  });
});
