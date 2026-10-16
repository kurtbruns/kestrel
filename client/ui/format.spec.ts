import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fmt,
  invalidAddressesMessage,
  lateStr,
  notSentMessage,
  parseAddresses,
  toLocalInput,
  untilStr,
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

describe("fmt", () => {
  // "Now" is pinned mid-year in the real clock's year, so each date below sits squarely
  // inside or outside the current year on any day the suite runs, New Year's Eve included.
  const year = new Date().getFullYear();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(year, 5, 15, 12, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a short local date and time, to the minute, and an em dash for none", () => {
    const at = new Date(year, 8, 5, 7, 3, 45).getTime();
    expect(fmt(at)).toMatch(/\b5\b/); // the day
    expect(fmt(at)).toMatch(/:03\b/); // the minute, padded; no seconds
    expect(fmt(at)).not.toMatch(/:45/);
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
    expect(fmt(0)).toBe("—"); // no timestamp is the epoch
  });

  it("leaves the year off a date in the current year, at either end of it", () => {
    for (const at of [new Date(year, 0, 1, 0, 0), new Date(year, 11, 31, 23, 59)]) {
      expect(fmt(at.getTime())).not.toContain(String(year));
    }
  });

  it("shows the year on a date from an earlier year", () => {
    expect(fmt(new Date(year - 2, 1, 11, 2, 0).getTime())).toContain(String(year - 2));
    expect(fmt(new Date(year - 1, 11, 31, 23, 59).getTime())).toContain(String(year - 1));
  });

  it("shows the year on a date in a later year, such as a send scheduled for next January", () => {
    expect(fmt(new Date(year + 1, 0, 2, 9, 0).getTime())).toContain(String(year + 1));
  });
});

describe("toLocalInput", () => {
  it("writes a datetime-local value in local time, padded, to the minute", () => {
    expect(toLocalInput(new Date(2026, 8, 5, 7, 3, 45))).toBe("2026-09-05T07:03");
    expect(toLocalInput(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31T23:59");
    // What the input hands back reads as the same moment, to the minute.
    const d = new Date(2026, 0, 2, 3, 4);
    expect(new Date(toLocalInput(d)).getTime()).toBe(d.getTime());
  });
});

describe("untilStr and lateStr", () => {
  const NOW = 1_700_000_000_000;
  const s = 1000;
  const min = 60 * s;
  const hr = 60 * min;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("ticks seconds only in the last five minutes, then coarsens by minute, hour, and day", () => {
    const until = (ms: number) => untilStr(NOW + ms);
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
    expect(until(35 * hr)).toBe("Sends in 1 day");
    expect(until(36 * hr)).toBe("Sends in 2 days"); // whole days, rounded
  });

  it("says Preparing to send from the fire time, or as soon as the server reads it due", () => {
    expect(untilStr(NOW)).toBe("Preparing to send…");
    expect(untilStr(NOW - min)).toBe("Preparing to send…");
    expect(untilStr(NOW + hr, true)).toBe("Preparing to send…");
  });

  it("says how many whole minutes late a missed send is, never fewer than none", () => {
    expect(lateStr(NOW - 7 * min - 59 * s)).toBe("Missed its fire time · 7 min late");
    expect(lateStr(NOW - 5 * min)).toBe("Missed its fire time · 5 min late");
    expect(lateStr(NOW + min)).toBe("Missed its fire time · 0 min late"); // a clock behind
  });
});
