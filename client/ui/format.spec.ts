import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Clocks,
  fmt,
  fmtAt,
  invalidAddressesMessage,
  lateStr,
  notSentMessage,
  parseAddresses,
  secondClock,
  toLocalInput,
  untilStr,
  zoneHeader,
} from "./format";

describe("parseAddresses", () => {
  it("normalizes and dedupes the addresses, and keeps what isn't one, as typed", () => {
    expect(parseAddresses(" Me@Example.com, me@example.com\nTypo@gmail,,  , you@b.co ")).toEqual({
      valid: ["me@example.com", "you@b.co"],
      invalid: ["Typo@gmail"],
    });
  });

  it("reads empty input as nothing at all", () => {
    expect(parseAddresses("")).toEqual({ valid: [], invalid: [] });
    expect(parseAddresses(null)).toEqual({ valid: [], invalid: [] });
  });
});

describe("invalidAddressesMessage", () => {
  it("names the entries, or says nothing when there are none", () => {
    expect(invalidAddressesMessage([])).toBeNull();
    expect(invalidAddressesMessage(["typo@gmail"])).toBe("Not an email address: typo@gmail");
    expect(invalidAddressesMessage(["a", "b@c"])).toBe("Not email addresses: a, b@c");
  });
});

describe("notSentMessage", () => {
  const refused =
    "The provider refused it: ses 400 MessageRejected: Email address is not verified. Sending to this address again gets the same answer until what the provider names is fixed.";

  it("says the server's reason for a lone address, with no retry advice of its own (SPEC §5)", () => {
    expect(notSentMessage(0, 1, [{ email: "you@b.c", message: refused }])).toBe(refused);
  });

  it("names whose each reason is, once per reason, and who Send again goes to", () => {
    const noAnswer =
      "The provider didn’t answer, so the test may have arrived: timeout. Check the inbox before sending it again.";
    expect(
      notSentMessage(1, 4, [
        { email: "a@b.c", message: refused },
        { email: "b@b.c", message: noAnswer },
        { email: "c@b.c", message: refused },
      ]),
    ).toBe(
      `Sent to 1 of 4. a@b.c, c@b.c: ${refused} b@b.c: ${noAnswer} Send again goes only to those.`,
    );
  });

  it("still names an address that came back with no reason beside others that did", () => {
    expect(
      notSentMessage(0, 2, [
        { email: "a@b.c", message: refused },
        { email: "b@b.c", message: "" },
      ]),
    ).toBe(`a@b.c: ${refused} Not sent to b@b.c.`);
  });

  it("falls back to inviting a retry when there is no reason to give", () => {
    expect(notSentMessage(0, 1, [{ email: "you@b.c", message: "" }])).toBe(
      "Not sent. Send again to try.",
    );
    expect(notSentMessage(1, 2, [{ email: "you@b.c", message: "" }])).toBe(
      "Sent to 1 of 2. Not sent to you@b.c. Send again to try those.",
    );
  });
});

describe("fmt and the clocks a screen shows its times on (DESIGN §10)", () => {
  // "Now" is pinned mid-year in the real clock's year, so each date below sits squarely
  // inside or outside the current year on any day the suite runs, New Year's Eve included.
  const year = new Date().getFullYear();
  const NY = "America/New_York";
  const home: Clocks = { home: NY, browser: NY, away: false, label: "Eastern Time" };
  const away: Clocks = { home: NY, browser: "Asia/Tokyo", away: true, label: "Eastern Time" };
  // 9:00 AM in New York in September (UTC-4), as a moment.
  const at = (month: number, day: number, h: number, m: number, y = year) =>
    Date.UTC(y, month, day, h + 4, m);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(year, 5, 15, 16, 0)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a short date and time on the publication's clock, to the minute, and an em dash for none", () => {
    expect(fmt(at(8, 5, 7, 3) + 45_000, home)).toBe("Sep 5, 7:03 AM");
    expect(fmt(at(8, 5, 7, 3), away)).toBe("Sep 5, 7:03 AM"); // whatever the browser's clock
    expect(fmt(at(8, 4, 9, 0), home, true)).toMatch(/^\w{3} Sep 4, 9:00 AM$/); // still to come
    expect(fmt(null, home)).toBe("—");
    expect(fmt(undefined, home)).toBe("—");
    expect(fmt(0, home)).toBe("—"); // no timestamp is the epoch
  });

  it("shows the year only for a date outside the publication's current year, either way", () => {
    expect(fmt(Date.UTC(year, 0, 1, 5, 0), home)).not.toContain(String(year));
    expect(fmt(Date.UTC(year + 1, 0, 1, 4, 59), home)).not.toContain(String(year)); // Dec 31 there
    expect(fmt(Date.UTC(year - 2, 1, 11, 7, 0), home)).toContain(String(year - 2));
    expect(fmt(Date.UTC(year + 1, 0, 2, 14, 0), home)).toContain(String(year + 1));
  });

  it("names the zone only away: after a lone time, once in a header, and a second clock under an upcoming one", () => {
    const fire = at(8, 4, 9, 0);
    expect(fmtAt(fire, home)).toBe("Sep 4, 9:00 AM");
    expect(fmtAt(fire, away)).toBe("Sep 4, 9:00 AM Eastern Time");
    expect(zoneHeader("When", home)).toBe("When");
    expect(zoneHeader("When", away)).toBe("When · Eastern Time");
    expect(secondClock(fire, home)).toBeNull();
    expect(secondClock(fire, away)).toMatch(/^\w{3} 10:00 PM your time · Japan Standard Time$/);
  });
});

describe("toLocalInput", () => {
  it("writes a datetime-local value on the publication's clock, padded, to the minute", () => {
    expect(toLocalInput(Date.UTC(2026, 8, 5, 11, 3, 45), "America/New_York")).toBe(
      "2026-09-05T07:03",
    );
    expect(toLocalInput(Date.UTC(2026, 8, 5, 11, 3), "Asia/Tokyo")).toBe("2026-09-05T20:03");
  });
});

describe("untilStr and lateStr", () => {
  const NOW = 1_700_000_000_000;
  const s = 1000;
  const min = 60 * s;
  const hr = 60 * min;
  const NY = "America/New_York";
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("ticks seconds only in the last five minutes, then coarsens by minute, hour, days and hours, and days", () => {
    const until = (ms: number) => untilStr(NOW + ms, NY);
    expect(until(45 * s)).toBe("Sends in 45s");
    expect(until(90 * s)).toBe("Sends in 1m 30s");
    expect(until(4 * min + 5 * s)).toBe("Sends in 4m 05s");
    expect(until(5 * min - 1)).toBe("Sends in 4m 59s");
    expect(until(5 * min)).toBe("Sends in 5m");
    expect(until(hr - 1)).toBe("Sends in 59m");
    expect(until(hr)).toBe("Sends in 1h");
    expect(until(hr + min)).toBe("Sends in 1h 1m");
    expect(until(24 * hr - 1)).toBe("Sends in 23h 59m");
    expect(until(24 * hr)).toBe("Sends in 1 day");
    expect(until(35 * hr)).toBe("Sends in 1 day, 11 hours");
    expect(until(55 * hr + 30 * min)).toBe("Sends in 2 days, 7 hours"); // rounded down
    expect(until(72 * hr)).toBe("Sends in 3 days");
    expect(until(9 * 24 * hr + 20 * hr)).toBe("Sends in 9 days"); // whole days from three on
  });

  it("says Preparing to send from the fire time, or as soon as the server reads it due", () => {
    expect(untilStr(NOW, NY)).toBe("Preparing to send…");
    expect(untilStr(NOW - min, NY)).toBe("Preparing to send…");
    expect(untilStr(NOW + hr, NY, true)).toBe("Preparing to send…");
  });

  it("says how many whole minutes late a missed send is, never fewer than none", () => {
    expect(lateStr(NOW - 7 * min - 59 * s)).toBe("Missed its fire time · 7 min late");
    expect(lateStr(NOW - 5 * min)).toBe("Missed its fire time · 5 min late");
    expect(lateStr(NOW + min)).toBe("Missed its fire time · 0 min late"); // a clock behind
  });
});
