// The publication's time zone (SPEC §9): an IANA name the runtime knows, labeled by the
// runtime, required before anything is scheduled or sent, never moving a scheduled send when
// it changes, and dating each post by the publication's day on every reader surface.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { formatClockTime, formatInTimeZone } from "../shared/time_zone";
import * as posts from "../src/db/posts";
import { getSettings } from "../src/db/settings";
import { clearFakeOutbox } from "../src/providers/fake";
import { TIME_ZONE_NOT_SET } from "../src/send/schedule";
import {
  dueSend,
  resetDatabase,
  seedConfirmed,
  setRow,
  setTimeZone,
  tick,
  unsetTimeZone,
} from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { fetchWith } from "./support/worker_env";

const HOUR = 3_600_000;

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const saveZone = (time_zone: unknown) => call("PUT", "/api/settings", { time_zone });

async function draft(): Promise<string> {
  const res = await call("POST", "/api/posts", { subject: "Owls", markdown: "# Hi" });
  expect(res.status).toBe(201);
  return (await readJson(res)).post.id;
}

/** A draft scheduled through the API at `fireAt`: the send's id and the fire time it stored,
 *  on the minute. */
async function scheduleAt(fireAt: number): Promise<string> {
  return (await scheduled(fireAt)).id;
}

async function scheduled(fireAt: number): Promise<{ id: string; fire_at: number }> {
  const res = await call("POST", `/api/posts/${await draft()}/schedule`, { fire_at: fireAt });
  expect(res.status).toBe(201);
  return (await readJson(res)).send;
}

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

describe("the setting (SPEC §9)", () => {
  it("takes an IANA name the runtime knows, and answers its long generic name, never an abbreviation", async () => {
    const res = await saveZone("America/New_York");
    expect(res.status).toBe(200);
    const { settings } = await readJson(res);
    expect([settings.time_zone, settings.time_zone_label]).toEqual([
      "America/New_York",
      "Eastern Time",
    ]);
    const read = await readJson(await call("GET", "/api/settings"));
    expect([read.settings.time_zone, read.settings.time_zone_label]).toEqual([
      "America/New_York",
      "Eastern Time",
    ]);
    // A zone with no generic name reads as its offset.
    expect((await readJson(await saveZone("Etc/GMT+5"))).settings.time_zone_label).toBe(
      "GMT-05:00",
    );
    expect((await readJson(await saveZone("Asia/Tokyo"))).settings.time_zone_label).toBe(
      "Japan Standard Time",
    );
  });

  it("refuses a name the runtime doesn't know, or none, naming the field and keeping the zone", async () => {
    await saveZone("Asia/Tokyo");
    for (const bad of ["Mars/Olympus_Mons", "", "-05:00"]) {
      const res = await saveZone(bad);
      expect(res.status, bad).toBe(400);
      const body = await readJson(res);
      expect([body.error, body.field], bad).toEqual(["bad_request", "time_zone"]);
    }
    expect((await readJson(await saveZone("Mars/Olympus_Mons"))).message).toBe(
      "“Mars/Olympus_Mons” isn’t a time zone this server knows. Use an IANA name, such as America/New_York.",
    );
    // Not text at all is the router's 400 on the field's type.
    expect((await saveZone(null)).status).toBe(400);
    expect((await getSettings(env.DB)).timeZone).toBe("Asia/Tokyo");
  });

  it("stores an alias as the zone it resolves to, so two names for one zone are one zone", async () => {
    expect((await readJson(await saveZone("US/Eastern"))).settings.time_zone).toBe(
      "America/New_York",
    );
    expect((await readJson(await saveZone("america/new_york"))).settings.time_zone).toBe(
      "America/New_York",
    );
    // The engine behind Workers reads Asia/Kolkata as Asia/Calcutta, so a save of either
    // stores the same zone, and switching between them is no change.
    const kolkata = (await readJson(await saveZone("Asia/Kolkata"))).settings;
    const calcutta = (await readJson(await saveZone("Asia/Calcutta"))).settings;
    expect(kolkata.time_zone).toBe(calcutta.time_zone);
    expect(kolkata.time_zone_label).toBe("India Standard Time");
    await scheduleAt(Date.now() + 2 * HOUR);
    expect((await readJson(await saveZone("Asia/Kolkata"))).time_zone_readings).toEqual([]);
  });
});

describe("required before anything goes to readers (SPEC §9)", () => {
  it("refuses schedule, Send now, and reschedule while none is set, in words fit to show", async () => {
    const id = await draft();
    const sendId = await scheduleAt(Date.now() + 2 * HOUR);
    await unsetTimeZone();
    const refused = [
      await call("POST", `/api/posts/${id}/schedule`, { fire_at: Date.now() + HOUR }),
      await call("POST", `/api/posts/${id}/send`, {}),
      await call("POST", `/api/sends/${sendId}/reschedule`, { fire_at: Date.now() + 3 * HOUR }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(409);
      expect(await readJson(res)).toEqual({
        error: "time_zone_not_set",
        message: "Set the publication’s time zone before scheduling or sending. It’s in Settings.",
      });
    }
    expect(TIME_ZONE_NOT_SET).toBe(
      "Set the publication’s time zone before scheduling or sending. It’s in Settings.",
    );
    // Nothing was scheduled and nothing moved.
    expect((await readJson(await call("GET", `/api/posts/${id}`))).post.status).toBe("draft");
    // And neither the post nor the send offers what would be refused (API principle 3).
    const post = (await readJson(await call("GET", `/api/posts/${id}`))).post;
    expect(post.actions.map((a: { name: string }) => a.name)).toEqual(["edit", "delete"]);
    const send = (await readJson(await call("GET", `/api/sends/${sendId}`))).send;
    expect(send.actions.map((a: { name: string }) => a.name)).toEqual(["cancel"]);
  });

  it("leaves everything else working: drafts, tests, preview, subscribers, cancel, and Settings", async () => {
    const sendId = await scheduleAt(Date.now() + 2 * HOUR);
    await unsetTimeZone();
    const id = await draft();
    const saved = await call("PUT", `/api/posts/${id}`, {
      subject: "Owls at dusk",
      markdown: "# Hi again",
      base_revision: (await readJson(await call("GET", `/api/posts/${id}`))).post.current_revision,
    });
    expect(saved.status).toBe(200);
    expect((await call("POST", `/api/posts/${id}/test`, { to: "you@example.com" })).status).toBe(
      200,
    );
    expect((await call("GET", `/api/posts/${id}/preview`)).status).toBe(200);
    expect((await call("POST", "/api/subscribers", { email: "reader@example.com" })).status).toBe(
      201,
    );
    expect((await call("POST", `/api/sends/${sendId}/cancel`)).status).toBe(200);
    expect(
      (await call("PUT", "/api/settings", { publication: { name: "Field Notes" } })).status,
    ).toBe(200);
    // And Settings is where it gets set.
    expect((await saveZone("America/Chicago")).status).toBe(200);
    expect((await call("POST", `/api/posts/${id}/send`, {})).status).toBe(201);
  });

  it("still fires a send scheduled before the zone was unset", async () => {
    await seedConfirmed("a@example.com");
    const send = await dueSend();
    await unsetTimeZone();
    await tick();
    const after = (await readJson(await call("GET", `/api/sends/${send.id}`))).send;
    expect(after.status).toBe("sent");
    expect(after.counts.accepted + after.counts.delivered).toBe(1);
  });

  it("reads a stored zone the runtime doesn't know as unset, refusing sending loudly", async () => {
    await env.DB.prepare(
      "UPDATE settings SET data = json_set(data, '$.timeZone', 'Mars/Olympus_Mons') WHERE id = 1",
    ).run();
    const read = await readJson(await call("GET", "/api/settings"));
    expect([read.settings.time_zone, read.settings.time_zone_label]).toEqual([null, null]);
    const res = await call("POST", `/api/posts/${await draft()}/schedule`, {
      fire_at: Date.now() + HOUR,
    });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("time_zone_not_set");
  });

  it("is refused for want of a provider first, where none is connected either (SPEC §13)", async () => {
    const id = await draft();
    await unsetTimeZone();
    const res = await fetchWith({ SIMULATE_SENDS: "not-connected" }, `/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: Date.now() + HOUR }),
    });
    expect(res.status).toBe(503);
    expect((await readJson(res)).error).toBe("provider_not_connected");
  });
});

describe("changing it (SPEC §9)", () => {
  it("moves no scheduled send, and says how each now reads", async () => {
    await saveZone("America/New_York");
    // Tomorrow at 9:00 AM New York time, worked out from New York's clock now.
    const fireAt = nineAmTomorrowIn("America/New_York");
    const sendId = await scheduleAt(fireAt);
    const res = await saveZone("America/Chicago");
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.time_zone_readings).toEqual([
      `Your scheduled post stays at the same moment, now ${formatInTimeZone(fireAt, "America/Chicago")}. Move it if you meant 9:00 AM.`,
    ]);
    expect(body.time_zone_readings[0]).toMatch(/, 8:00 AM Central Time\. Move it if you meant/);
    const send = (await readJson(await call("GET", `/api/sends/${sendId}`))).send;
    expect(send.fire_at).toBe(fireAt);
    expect(body.remade).toEqual([]);
    // A save that leaves the zone as it is says nothing.
    expect((await readJson(await saveZone("America/Chicago"))).time_zone_readings).toEqual([]);
  });

  it("names each send by its subject when several are scheduled", async () => {
    await saveZone("America/New_York");
    const a = (await scheduled(Date.now() + 2 * HOUR)).fire_at;
    const b = (await scheduled(Date.now() + 5 * HOUR)).fire_at;
    const body = await readJson(await saveZone("Asia/Tokyo"));
    const meant = (ms: number) => formatClockTime(ms, "America/New_York");
    expect(body.time_zone_readings).toEqual([
      `Your scheduled post “Owls” stays at the same moment, now ${formatInTimeZone(a, "Asia/Tokyo")}. Move it if you meant ${meant(a)}.`,
      `Your scheduled post “Owls” stays at the same moment, now ${formatInTimeZone(b, "Asia/Tokyo")}. Move it if you meant ${meant(b)}.`,
    ]);
  });

  it("says nothing when the zone is set for the first time: nothing was read on a publication clock", async () => {
    await scheduled(Date.now() + 2 * HOUR);
    await unsetTimeZone();
    expect((await readJson(await saveZone("Asia/Tokyo"))).time_zone_readings).toEqual([]);
  });
});

/** 9:00 AM tomorrow on `zone`'s clock, as an instant: found by stepping from the UTC guess. */
function nineAmTomorrowIn(zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(Date.now() + 24 * HOUR);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const guess = Date.UTC(get("year"), get("month") - 1, get("day"), 9);
  // The zone's offset at the guess, in minutes, read back from its own clock.
  const local = new Date(new Date(guess).toLocaleString("en-US", { timeZone: zone }));
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return guess - (local.getTime() - utc.getTime());
}

describe("public dates (SPEC §5, §9)", () => {
  // 8 PM in New York on March 2, 2026, which is already March 3 in UTC.
  const EVENING_IN_NEW_YORK = Date.UTC(2026, 2, 3, 1, 0);

  /** A post sent at that moment, as each reader surface serves it. */
  async function sentAtEvening(): Promise<{ slug: string; id: string }> {
    await seedConfirmed("a@example.com");
    const send = await dueSend({ subject: "Evening owls" });
    await tick();
    await setRow(send.id, { started_at: EVENING_IN_NEW_YORK, fire_at: EVENING_IN_NEW_YORK });
    const post = await posts.getPost(env.DB, send.post_id);
    return { slug: post?.slug ?? "", id: send.post_id };
  }

  async function surfaces(slug: string, id: string): Promise<Record<string, string>> {
    const page = async (path: string, headers: HeadersInit = {}) =>
      (await SELF.fetch(`${base}${path}`, { headers })).text();
    return {
      landing: await page("/"),
      archive: await page("/archive"),
      post: await page(`/archive/${slug}`),
      web: await page(`/api/posts/${id}/web`, AUTH),
    };
  }

  it("dates a post by the publication's day on its page, the archive, the landing page, and the web version", async () => {
    await setTimeZone("America/New_York");
    const { slug, id } = await sentAtEvening();
    for (const [where, html] of Object.entries(await surfaces(slug, id))) {
      expect(html, where).toContain("March 2, 2026");
      expect(html, where).not.toContain("March 3, 2026");
      // No zone is named beside it.
      expect(html, where).not.toContain("Eastern Time");
    }
  });

  it("dates it in UTC while no zone is set, as before the setting", async () => {
    await unsetTimeZone();
    const { slug, id } = await sentAtEvening();
    for (const [where, html] of Object.entries(await surfaces(slug, id))) {
      expect(html, where).toContain("March 3, 2026");
      expect(html, where).not.toContain("March 2, 2026");
    }
  });
});
