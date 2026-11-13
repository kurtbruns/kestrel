// A requested fire time (SPEC §6): a local time is the publication's clock, a local time with
// `time_zone` is that place's, and `Z` or epoch milliseconds is an exact moment. A numeric
// offset is refused, and so is a local time a clock change skips or repeats, in words worked
// out from the change. An act's answer reads the fire time back, and `GET /api/time` gives the
// publication's time now and how a time would read.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { onTheMinute } from "../src/send/schedule";
import { resetDatabase, setTimeZone, unsetTimeZone } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// Next year, so every time here is in the future and its year is shown, on any date.
const YEAR = new Date().getUTCFullYear() + 1;
const pad = (n: number) => String(n).padStart(2, "0");

/** The day of the month of a month's nth Sunday in YEAR (US clock changes fall on Sundays). */
function nthSunday(month: number, n: number): number {
  const first = new Date(Date.UTC(YEAR, month - 1, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
}
const local = (month: number, day: number, time: string) =>
  `${YEAR}-${pad(month)}-${pad(day)}T${time}`;
const shortDay = (month: number, day: number) =>
  new Date(Date.UTC(YEAR, month - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

// Nov 13 is after the first Sunday of November, so New York is on UTC-5 and Sydney on UTC+11.
const NOV_13_9AM = local(11, 13, "09:00");
const NOV_13_9AM_NEW_YORK = Date.UTC(YEAR, 10, 13, 14, 0);
const NOV_13_9AM_SYDNEY = Date.UTC(YEAR, 10, 12, 22, 0);

async function draft(): Promise<string> {
  const res = await call("POST", "/api/posts", { subject: "Owls", markdown: "# Hi" });
  expect(res.status).toBe(201);
  return (await readJson(res)).post.id;
}

const schedule = async (body: Record<string, unknown>) =>
  call("POST", `/api/posts/${await draft()}/schedule`, body);

async function requested(sendId: string) {
  return env.DB.prepare("SELECT requested_local_time, requested_time_zone FROM sends WHERE id = ?")
    .bind(sendId)
    .first();
}

beforeEach(async () => {
  await resetDatabase();
  await setTimeZone("America/New_York");
});

describe("the forms fire_at takes (SPEC §6)", () => {
  it("reads a local time with no offset on the publication's clock, keeps what was asked, and reads it back", async () => {
    const res = await schedule({ fire_at: NOV_13_9AM });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.send.fire_at).toBe(NOV_13_9AM_NEW_YORK);
    expect(body.read_back.fire_at_local).toBe(
      `${shortDay(11, 13).replace(",", "")}, ${YEAR}, 9:00 AM Eastern Time`,
    );
    expect(body.read_back.fire_at_in).toMatch(/^in \d+ days(, \d+ hours?)?$/);
    expect(body.read_back.now_local).toMatch(/ Eastern Time$/);
    expect(await requested(body.send.id)).toEqual({
      requested_local_time: NOV_13_9AM,
      requested_time_zone: "America/New_York",
    });
  });

  it("reads a local time with time_zone on that place's clock, for that date's offset", async () => {
    const body = await readJson(
      await schedule({ fire_at: NOV_13_9AM, time_zone: "Australia/Sydney" }),
    );
    expect(body.send.fire_at).toBe(NOV_13_9AM_SYDNEY);
    // The read-back is still the publication's clock.
    expect(body.read_back.fire_at_local).toMatch(/, 5:00 PM Eastern Time$/);
    expect(await requested(body.send.id)).toEqual({
      requested_local_time: NOV_13_9AM,
      requested_time_zone: "Australia/Sydney",
    });
  });

  it("keeps a local time asked with seconds as the minute the send fires at", async () => {
    const body = await readJson(await schedule({ fire_at: `${NOV_13_9AM}:30` }));
    expect(body.send.fire_at).toBe(NOV_13_9AM_NEW_YORK + 60_000);
    expect(await requested(body.send.id)).toEqual({
      requested_local_time: local(11, 13, "09:01"),
      requested_time_zone: "America/New_York",
    });
  });

  it("takes an exact moment as Z or epoch milliseconds, and keeps no local time for it", async () => {
    const at = Date.now() + 3 * 3_600_000;
    for (const fire_at of [
      new Date(at).toISOString(),
      new Date(at).toISOString().replace("Z", "z"),
      at,
      String(at),
    ]) {
      const res = await schedule({ fire_at });
      expect(res.status, String(fire_at)).toBe(201);
      const body = await readJson(res);
      expect(body.send.fire_at).toBe(onTheMinute(at));
      expect(await requested(body.send.id)).toEqual({
        requested_local_time: null,
        requested_time_zone: null,
      });
    }
  });

  it("refuses a numeric offset, saying to send the local time instead", async () => {
    for (const fire_at of [`${NOV_13_9AM}-05:00`, `${NOV_13_9AM}:00+09:00`, `${NOV_13_9AM}+0900`]) {
      const res = await schedule({ fire_at });
      expect(res.status, fire_at).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe("bad_request");
      expect(body.field).toBe("fire_at");
      expect(body.message).toBe(
        "fire_at can’t carry an offset: one copied from today’s clock is wrong across a clock change. Send the local time with no offset, which is the publication’s time, with time_zone if it’s another place’s time.",
      );
    }
  });

  it("refuses a schedule with no fire_at as required, not as a time it can't read", async () => {
    for (const body of [{}, { time_zone: "Asia/Tokyo" }]) {
      const res = await schedule(body);
      expect(res.status).toBe(400);
      const read = await readJson(res);
      expect(read.field).toBe("fire_at");
      expect(read.message).toMatch(/^fire_at is required\. Send a local time/);
    }
  });

  it("refuses what isn't a time, naming the forms it takes", async () => {
    for (const fire_at of [
      `${YEAR}-11-13`,
      `${YEAR}-02-30T09:00`,
      `${YEAR}-11-13 09:00`,
      "Friday",
      true,
    ]) {
      const res = await schedule({ fire_at });
      expect(res.status, String(fire_at)).toBe(400);
      const body = await readJson(res);
      expect(body.field).toBe("fire_at");
      expect(body.message).toMatch(/^fire_at isn’t a time Kestrel reads\. Send a local time/);
    }
  });

  it("refuses time_zone beside an exact moment, and a zone that is no place's clock", async () => {
    const exact = await schedule({ fire_at: Date.now() + 3_600_000, time_zone: "Asia/Tokyo" });
    expect(exact.status).toBe(400);
    expect((await readJson(exact)).field).toBe("time_zone");
    const est = await readJson(await schedule({ fire_at: NOV_13_9AM, time_zone: "EST" }));
    expect(est.field).toBe("time_zone");
    expect(est.message).toBe(
      "EST isn’t a place: it never changes for daylight saving time. Use the place your readers keep, such as America/New_York.",
    );
  });
});

describe("a local time around a clock change (SPEC §6)", () => {
  const spring = nthSunday(3, 2);
  const fall = nthSunday(11, 1);

  it("refuses a time the clocks skip, in the publication's zone, saying the change", async () => {
    const body = await readJson(await schedule({ fire_at: local(3, spring, "02:30") }));
    expect(body.field).toBe("fire_at");
    expect(body.message).toBe(
      `2:30 AM doesn’t happen on ${shortDay(3, spring).replace(",", "")}, ${YEAR} in Eastern Time: clocks jump from 2:00 to 3:00 AM. Pick a time before 2:00 AM or from 3:00 AM.`,
    );
  });

  it("refuses a time that happens twice, in a zone named by time_zone, saying the change", async () => {
    await setTimeZone("Asia/Tokyo");
    const body = await readJson(
      await schedule({ fire_at: local(11, fall, "01:30"), time_zone: "America/Chicago" }),
    );
    expect(body.field).toBe("fire_at");
    expect(body.message).toBe(
      `1:30 AM happens twice on ${shortDay(11, fall).replace(",", "")}, ${YEAR} in Central Time: clocks go back from 2:00 to 1:00 AM. Pick a time before 1:00 AM or from 2:00 AM.`,
    );
  });

  it("refuses the same on a reschedule, and a move replaces or clears the local time it keeps", async () => {
    const { send } = await readJson(await schedule({ fire_at: NOV_13_9AM }));
    const move = (body: Record<string, unknown>) =>
      call("POST", `/api/sends/${send.id}/reschedule`, body);

    const skipped = await readJson(await move({ fire_at: local(3, spring, "02:30") }));
    expect(skipped.field).toBe("fire_at");
    expect(skipped.message).toMatch(/^2:30 AM doesn’t happen /);

    const moved = await readJson(await move({ fire_at: local(11, 14, "10:15") }));
    expect(moved.changed).toBe(true);
    expect(moved.send.fire_at).toBe(Date.UTC(YEAR, 10, 14, 15, 15));
    expect(moved.read_back.fire_at_local).toMatch(/, 10:15 AM Eastern Time$/);
    expect(await requested(send.id)).toEqual({
      requested_local_time: local(11, 14, "10:15"),
      requested_time_zone: "America/New_York",
    });

    const exact = Date.UTC(YEAR, 10, 15, 12, 0);
    expect((await readJson(await move({ fire_at: exact }))).send.fire_at).toBe(exact);
    expect(await requested(send.id)).toEqual({
      requested_local_time: null,
      requested_time_zone: null,
    });
  });
});

describe("the publication's time (GET /api/time)", () => {
  it("answers the time now on the publication's clock, and how a local time reads, without scheduling", async () => {
    const before = Date.now();
    const body = await readJson(await call("GET", `/api/time?fire_at=${NOV_13_9AM}`));
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(body.time_zone).toBe("America/New_York");
    expect(body.time_zone_label).toBe("Eastern Time");
    expect(body.now_local).toMatch(/ Eastern Time$/);
    expect(body.fire_at).toBe(NOV_13_9AM_NEW_YORK);
    expect(body.read_back.fire_at_local).toMatch(/, 9:00 AM Eastern Time$/);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sends").first()) as {
      n: number;
    };
    expect(n).toBe(0);
  });

  it("reads another place's time, and refuses a clock change as scheduling does", async () => {
    const sydney = await readJson(
      await call("GET", `/api/time?fire_at=${NOV_13_9AM}&time_zone=Australia/Sydney`),
    );
    expect(sydney.fire_at).toBe(NOV_13_9AM_SYDNEY);
    const res = await call("GET", `/api/time?fire_at=${local(3, nthSunday(3, 2), "02:30")}`);
    expect(res.status).toBe(400);
    expect((await readJson(res)).message).toMatch(/^2:30 AM doesn’t happen /);
  });

  it("with no time zone set, reads now in UTC, and refuses only a local time on the publication's clock", async () => {
    await unsetTimeZone();
    const plain = await readJson(await call("GET", "/api/time"));
    expect(plain.time_zone).toBeNull();
    expect(plain.now_local).toMatch(/ UTC$/);
    expect(plain.fire_at).toBeNull();
    expect(plain.read_back).toBeNull();
    const refused = await call("GET", `/api/time?fire_at=${NOV_13_9AM}`);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("time_zone_not_set");
    const named = await readJson(
      await call("GET", `/api/time?fire_at=${NOV_13_9AM}&time_zone=America/New_York`),
    );
    expect(named.fire_at).toBe(NOV_13_9AM_NEW_YORK);
  });
});
