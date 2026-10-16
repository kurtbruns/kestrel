import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utcDayStart } from "../shared/daily_writes";
import { IMPORT_OUTCOMES } from "../shared/imports";
import { DAILY_WRITES_SEND_RECIPIENTS, DEFAULT_MIN_LEAD_MS } from "../shared/sends";
import * as sendsDb from "../src/db/sends";
import type { AppEnv } from "../src/env";
import { acceptFireAt, cancel, onTheMinute } from "../src/send/schedule";
import { addresses, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, PNG_1x1, readJson } from "./support/http";
import { fetchWith } from "./support/worker_env";

// Each test starts from an empty database, so a count or a list read sees only its own rows.
beforeEach(async () => {
  await resetDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A draft made through the API, its id. */
async function makeDraft({
  markdown = "# Hi\n\nbody",
  subject = "The Subject",
}: {
  markdown?: string;
  subject?: string;
} = {}): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject, markdown }),
    }),
  );
  return created.post.id;
}

function future(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

/** A send's frozen email, read at its own route. */
async function emailOf(id: string): Promise<string> {
  return (await SELF.fetch(`${base}/api/sends/${id}/email`, { headers: AUTH })).text();
}

async function postStatus(id: string): Promise<string> {
  const body = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
  return body.post.status;
}

describe("schedule / send / cancel + soft-lock", () => {
  it("schedules a future send, freezes the render, and locks the post (I3, I6)", async () => {
    const id = await makeDraft();
    const res = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.status).toBe("scheduled");
    expect(await emailOf(send.id)).toContain("The Subject");
    expect(await postStatus(id)).toBe("scheduled");
  });

  it("soft-locks edits and image changes while scheduled (409)", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });

    const put = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "changed" }),
    });
    expect(put.status).toBe(409);

    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "x.png", { type: "image/png" }));
    const img = await SELF.fetch(`${base}/api/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(img.status).toBe(409);

    // second schedule while active → 409
    const again = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });
    expect(again.status).toBe(409);
  });

  it("rejects fire_at that isn't at least the buffer in the future (400)", async () => {
    const id = await makeDraft();
    for (const fire_at of [future(-1000), future(60 * 1000)]) {
      const res = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("blocks scheduling and send-now on an empty subject (400), leaving the post a draft", async () => {
    // The subject is the one field the reader sees, and a send is irreversible (I4),
    // so freeze() rejects it before anything is frozen — for both clients, both paths.
    for (const subject of ["", "   "]) {
      const id = await makeDraft({ subject });

      const sched = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      });
      expect(sched.status).toBe(400);

      const now = await SELF.fetch(`${base}/api/posts/${id}/send`, {
        method: "POST",
        headers: AUTH,
      });
      expect(now.status).toBe(400);

      // neither attempt froze a send or locked the post
      expect(await postStatus(id)).toBe("draft");
    }
  });

  it("cancel unlocks the post; the frozen render is unchanged by later edits (I3)", async () => {
    const id = await makeDraft({ markdown: "original body" });
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const sendId = scheduled.send.id;
    const frozenHtml = await emailOf(sendId);

    const cancel = await SELF.fetch(`${base}/api/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(cancel.status).toBe(200);
    expect(await postStatus(id)).toBe("draft");

    // edit is allowed again
    const { post } = await readJson(await SELF.fetch(`${base}/api/posts/${id}`, { headers: AUTH }));
    const put = await SELF.fetch(`${base}/api/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({
        markdown: "totally different body",
        base_revision: post.current_revision,
      }),
    });
    expect(put.status).toBe(200);

    // the canceled send's frozen bytes did not change
    const still = await emailOf(sendId);
    expect(still).toBe(frozenHtml);
    expect(still).toContain("original body");

    // cancel again → nothing to do: 200, unchanged, so a retried cancel is safe. It takes no
    // rev either, so the feed reports no change that did not happen.
    const canceledRev = (await readJson(cancel)).send.rev;
    const twice = await SELF.fetch(`${base}/api/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(twice.status).toBe(200);
    expect(await readJson(twice)).toMatchObject({
      changed: false,
      send: { status: "canceled", rev: canceledRev },
    });
    const reread = await readJson(
      await SELF.fetch(`${base}/api/sends/${sendId}`, { headers: AUTH }),
    );
    expect(reread.send.rev).toBe(canceledRev);
  });

  it("cancel changes the send and the post together, or neither", async () => {
    const schedule = async (id: string) =>
      readJson(
        await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
        }),
      );
    const sendStatus = async (sendId: string) =>
      (await readJson(await SELF.fetch(`${base}/api/sends/${sendId}`, { headers: AUTH }))).send
        .status;

    // Both: the send is canceled and the post unlocked.
    const both = await makeDraft();
    const bothSend = (await schedule(both)).send.id;
    await cancel(env as AppEnv, bothSend);
    expect(await sendStatus(bothSend)).toBe("canceled");
    expect(await postStatus(both)).toBe("draft");

    // Neither: the post unlock fails, so the cancel rolls back with it.
    const neither = await makeDraft();
    const neitherSend = (await schedule(neither)).send.id;
    await env.DB.prepare(
      "CREATE TRIGGER fail_post_unlock BEFORE UPDATE OF status ON posts BEGIN SELECT RAISE(ABORT, 'unlock failed'); END",
    ).run();
    try {
      await expect(cancel(env as AppEnv, neitherSend)).rejects.toThrow(/unlock failed/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_post_unlock").run();
    }
    expect(await sendStatus(neitherSend)).toBe("scheduled");
    expect(await postStatus(neither)).toBe("scheduled");

    // Neither: a send already past the window is not canceled, and its post stays locked.
    const sending = await makeDraft();
    const sendingSend = (await schedule(sending)).send.id;
    await env.DB.prepare("UPDATE sends SET status = 'sending' WHERE id = ?")
      .bind(sendingSend)
      .run();
    await expect(cancel(env as AppEnv, sendingSend)).rejects.toMatchObject({
      status: 409,
      code: "window_closed",
    });
    expect(await sendStatus(sendingSend)).toBe("sending");
    expect(await postStatus(sending)).toBe("scheduled");
  });

  it("refuses a fire_at without a timezone (400 naming the field); offsets and epoch millis are accepted", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    const offsetless = at.toISOString().replace(/Z$/, "");
    for (const fire_at of [offsetless, offsetless.slice(0, 16), at.toISOString().slice(0, 10)]) {
      const id = await makeDraft();
      const res = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.field).toBe("fire_at");
      expect(body.message).toMatch(/timezone/);
      expect(await postStatus(id)).toBe("draft");
    }

    // The same instant written with an offset, as Z, as epoch millis (number or string).
    const plus2 = new Date(at.getTime() + 2 * 60 * 60 * 1000).toISOString().replace(/Z$/, "+02:00");
    const minus5 = new Date(at.getTime() - 5 * 60 * 60 * 1000)
      .toISOString()
      .replace(/Z$/, "-05:00");
    const lowerZ = at.toISOString().replace(/Z$/, "z");
    for (const fire_at of [
      plus2,
      minus5,
      lowerZ,
      at.toISOString(),
      at.getTime(),
      String(at.getTime()),
    ]) {
      const id = await makeDraft();
      const res = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(201);
      expect((await readJson(res)).send.fire_at).toBe(onTheMinute(at.getTime()));
    }

    // Reschedule reads fire_at the same way.
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const res = await SELF.fetch(`${base}/api/sends/${scheduled.send.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: offsetless }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("fire_at");
  });

  it("reschedules a scheduled send: moves fire_at, keeps the frozen render and the lock (I3, I6)", async () => {
    const id = await makeDraft({ markdown: "frozen body" });
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const sendId = scheduled.send.id;
    const frozenHtml = await emailOf(sendId);

    const newFire = future(60 * 60 * 1000);
    const res = await SELF.fetch(`${base}/api/sends/${sendId}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: newFire }),
    });
    expect(res.status).toBe(200);
    const { send } = await readJson(res);
    // only the fire time moved: still scheduled, at the new time
    expect(send.status).toBe("scheduled");
    expect(send.fire_at).toBe(onTheMinute(Date.parse(newFire)));
    // the frozen render and audience are untouched — no re-freeze (I3)
    expect(await emailOf(sendId)).toBe(frozenHtml);
    expect(frozenHtml).toContain("frozen body");
    expect(send.audience).toEqual(scheduled.send.audience);
    // scheduled_at is the review window's anchor: preserved, not reset — the window is
    // moved, not restarted (I6, SPEC §6 "Moving the fire time")
    expect(send.scheduled_at).toBe(scheduled.send.scheduled_at);
    // the post stays soft-locked (still scheduled) — reschedule never unlocks (I6)
    expect(await postStatus(id)).toBe("scheduled");
    // still the post's one active send, now at the new time
    const still = await readJson(
      await SELF.fetch(`${base}/api/sends/${sendId}`, { headers: AUTH }),
    );
    expect(still.send.fire_at).toBe(onTheMinute(Date.parse(newFire)));
  });

  it("rejects a reschedule fire_at that isn't at least the buffer out (400), leaving the time unchanged", async () => {
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    for (const fire_at of [future(-1000), future(60 * 1000)]) {
      const res = await SELF.fetch(`${base}/api/sends/${scheduled.send.id}/reschedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(400);
    }
    const still = await readJson(
      await SELF.fetch(`${base}/api/sends/${scheduled.send.id}`, { headers: AUTH }),
    );
    expect(still.send.fire_at).toBe(scheduled.send.fire_at);
  });

  it("won't reschedule a send that's no longer scheduled (409)", async () => {
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    await SELF.fetch(`${base}/api/sends/${scheduled.send.id}/cancel`, {
      method: "POST",
      headers: AUTH,
    });

    const res = await SELF.fetch(`${base}/api/sends/${scheduled.send.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(30 * 60 * 1000) }),
    });
    expect(res.status).toBe(409);
  });

  it("404s rescheduling an unknown send, and requires auth", async () => {
    const known = future(30 * 60 * 1000);
    const missing = await SELF.fetch(`${base}/api/sends/does-not-exist/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: known }),
    });
    expect(missing.status).toBe(404);

    const noauth = await SELF.fetch(`${base}/api/sends/does-not-exist/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fire_at: known }),
    });
    expect(noauth.status).toBe(401);
  });

  it("snapshots the audience at schedule time, as an estimate until it fires", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
      )
        .bind(`sub-${i}`, `c${i}@example.com`, `cfm-${i}`, `uns-${i}`, now, now)
        .run();
    }
    const id = await makeDraft();
    const { send } = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    expect(send.audience).toEqual({ count: 3, fixed: false, fixed_at: null });
  });

  it("send-now schedules at now + buffer and is idempotent", async () => {
    const id = await makeDraft();
    const first = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(first.send.status).toBe("scheduled");
    // One lead out, on the minute at or after it: never less than the lead, under a minute more.
    expect(first.send.fire_at % 60_000).toBe(0);
    const lead = first.send.fire_at - first.send.scheduled_at;
    expect(lead).toBeGreaterThan(DEFAULT_MIN_LEAD_MS - 2000);
    expect(lead).toBeLessThan(DEFAULT_MIN_LEAD_MS + 60_000);

    const second = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(second.idempotent).toBe(true);
    expect(second.send.id).toBe(first.send.id);
  });

  it("refuses a send-now repeat that asks for settings the post doesn't have, rather than answering success (SPEC §5)", async () => {
    const id = await makeDraft();
    const sendNow = (body: unknown) =>
      SELF.fetch(`${base}/api/posts/${id}/send`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(body),
      });
    const first = await readJson(await sendNow({}));
    // The post went in listed; a repeat asking for email only would change nothing.
    const refused = await sendNow({ email_only: true });
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      error: "active_send_exists",
      send: { id: first.send.id, email_only: false },
    });
    for (const other of [{ slug: "another-address" }, { slug_auto: false }]) {
      const res = await sendNow(other);
      expect(res.status, JSON.stringify(other)).toBe(409);
      expect((await readJson(res)).error).toBe("active_send_exists");
    }
    // A repeat naming what the post has is still the idempotent answer.
    const repeat = await sendNow({ email_only: false });
    expect(repeat.status).toBe(200);
    expect((await readJson(repeat)).idempotent).toBe(true);
  });

  it("refuses a stray template_revision on schedule and send-now (400): a send is made with the template as it stands", async () => {
    const id = await makeDraft();
    const sched = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000), template_revision: "tr_1" }),
    });
    expect(sched.status).toBe(400);
    const now = await SELF.fetch(`${base}/api/posts/${id}/send`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ template_revision: "tr_1" }),
    });
    expect(now.status).toBe(400);
    expect(await postStatus(id)).toBe("draft");
  });

  it("yields exactly one active send when two schedules race the same post", async () => {
    const id = await makeDraft();
    const fire = JSON.stringify({ fire_at: future(10 * 60 * 1000) });
    const call = () =>
      SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: fire,
      });

    // Fire both concurrently: whichever loses the race — to the app pre-check or,
    // under a true isolate interleaving, to the DB's partial unique index — gets a
    // 409, and the post is left with exactly one active send.
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const { results } = await env.DB.prepare(
      "SELECT id FROM sends WHERE post_id = ? AND status IN ('scheduled', 'sending')",
    )
      .bind(id)
      .all();
    expect(results.length).toBe(1);
  });

  it("leaves two send-nows for the same post with exactly one active send", async () => {
    const id = await makeDraft();
    const call = () =>
      SELF.fetch(`${base}/api/posts/${id}/send`, { method: "POST", headers: AUTH });

    const [a, b] = await Promise.all([call(), call()]);
    const { results } = await env.DB.prepare(
      "SELECT id FROM sends WHERE post_id = ? AND status IN ('scheduled', 'sending')",
    )
      .bind(id)
      .all<{ id: string }>();
    expect(results).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });

  it("answers a send-now that lost the race to another with the existing send, not a refusal (SPEC §6)", async () => {
    const id = await makeDraft();
    const first = await SELF.fetch(`${base}/api/posts/${id}/send`, {
      method: "POST",
      headers: AUTH,
    });
    expect(first.status).toBe(201);
    // The race made deterministic: the second request's own check runs before the first
    // request's send exists, so it sees none and goes on to freeze.
    vi.spyOn(sendsDb, "getActiveSendForPost").mockResolvedValueOnce(null);
    const second = await SELF.fetch(`${base}/api/posts/${id}/send`, {
      method: "POST",
      headers: AUTH,
    });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({
      idempotent: true,
      send: { id: (await readJson(first)).send.id },
    });
  });

  it("re-schedules a post after its prior send is canceled (predicate excludes terminal states)", async () => {
    const id = await makeDraft();
    const first = await readJson(
      await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    await SELF.fetch(`${base}/api/sends/${first.send.id}/cancel`, {
      method: "POST",
      headers: AUTH,
    });

    // The canceled send is out of the active set, so a fresh schedule succeeds.
    const again = await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });
    expect(again.status).toBe(201);
    expect((await readJson(again)).send.id).not.toBe(first.send.id);
  });

  it("lists sends and requires auth", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    const list = await readJson(await SELF.fetch(`${base}/api/sends`, { headers: AUTH }));
    expect(list.sends.length).toBeGreaterThanOrEqual(1);
    // The list row is the send's view: its counts read off the denormalized counters
    // (`sends.c_*`), never a per-row aggregate over the delivery record.
    expect(list.sends[0].counts).toHaveProperty("delivered");
    expect(list.sends[0].counts).toHaveProperty("pending");
    expect(list.sends[0]).not.toHaveProperty("c_delivered");

    const noauth = await SELF.fetch(`${base}/api/sends`);
    expect(noauth.status).toBe(401);
  });

  it("sends list carries a page envelope and honors the status filter + sort", async () => {
    // Two scheduled sends with different fire times.
    const idA = await makeDraft();
    await SELF.fetch(`${base}/api/posts/${idA}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    const idB = await makeDraft();
    await SELF.fetch(`${base}/api/posts/${idB}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });

    const list = await readJson(
      await SELF.fetch(`${base}/api/sends?status=scheduled&sort=fire&dir=asc&limit=100`, {
        headers: AUTH,
      }),
    );
    expect(list.page).toMatchObject({ sort: "fire", dir: "asc", offset: 0 });
    expect(list.sends.every((s: any) => s.status === "scheduled")).toBe(true);
    // fire asc → scheduled sends come back in ascending fire-time order.
    const fires = list.sends.map((s: any) => s.fire_at);
    expect(fires).toEqual([...fires].sort((a: number, b: number) => a - b));
  });
});

// The minimum lead is the deployment's (SPEC §6): `MIN_LEAD_SECONDS`, five minutes when
// unset. Every route that sets a fire time enforces the value the deployment names, and
// nothing else, so a deployment on the one-minute floor can schedule a minute out.
describe("the minimum lead is the deployment's own", () => {
  const MINUTE_LEAD = { MIN_LEAD_SECONDS: "60" };

  const scheduleAt = (vars: Record<string, string>, id: string, fire_at: string) =>
    fetchWith(vars, `/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at }),
    });

  it("schedules as close as the configured lead allows, and refuses closer, naming the lead", async () => {
    const id = await makeDraft();
    const tooClose = await scheduleAt(MINUTE_LEAD, id, future(30 * 1000));
    expect(tooClose.status).toBe(400);
    expect(await readJson(tooClose)).toEqual({
      error: "fire_at_too_soon",
      message: "Pick a time at least 1 minute from now, so there’s time to cancel.",
      field: "fire_at",
    });

    // Ninety seconds out: inside the default five minutes, outside a one-minute lead.
    const underDefault = await scheduleAt({}, id, future(90 * 1000));
    expect(underDefault.status).toBe(400);
    expect((await readJson(underDefault)).message).toMatch(
      /^Pick a time at least 5 minutes from now/,
    );
    const ok = await scheduleAt(MINUTE_LEAD, id, future(90 * 1000));
    expect(ok.status).toBe(201);
    expect(await postStatus(id)).toBe("scheduled");
  });

  it("sends now at one configured lead out", async () => {
    const id = await makeDraft();
    const res = await fetchWith(MINUTE_LEAD, `/api/posts/${id}/send`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.fire_at % 60_000).toBe(0);
    expect(send.fire_at - send.scheduled_at).toBeGreaterThan(60_000 - 2000);
    expect(send.fire_at - send.scheduled_at).toBeLessThan(120_000);
  });

  it("reschedules as close as the configured lead allows, and no closer", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await scheduleAt({}, id, future(10 * 60 * 1000)));
    const move = (vars: Record<string, string>, fire_at: string) =>
      fetchWith(vars, `/api/sends/${send.id}/reschedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
    expect((await move({}, future(90 * 1000))).status).toBe(400);
    expect((await move(MINUTE_LEAD, future(30 * 1000))).status).toBe(400);
    const moved = await move(MINUTE_LEAD, future(90 * 1000));
    expect(moved.status).toBe(200);
    expect((await readJson(moved)).send.status).toBe("scheduled");
  });

  it("reflects the lead read-only in the settings deployment view", async () => {
    const defaults = await readJson(await fetchWith({}, "/api/settings", { headers: AUTH }));
    expect(defaults.deployment.minLeadMs).toBe(DEFAULT_MIN_LEAD_MS);
    const minute = await readJson(await fetchWith(MINUTE_LEAD, "/api/settings", { headers: AUTH }));
    expect(minute.deployment.minLeadMs).toBe(60_000);
  });

  it("states the lead and its floor on every route that enforces it in the API reference", async () => {
    const ref = await readJson(await fetchWith(MINUTE_LEAD, "/api/reference", { headers: AUTH }));
    const routes = ref.groups.flatMap((g: any) => g.routes);
    for (const path of [
      "/api/posts/:id/schedule",
      "/api/posts/:id/send",
      "/api/sends/:id/reschedule",
    ]) {
      const route = routes.find((r: any) => r.path === path && r.method === "POST");
      expect(route?.description, path).toMatch(/1 minute on this deployment/);
      expect(route?.description, path).toMatch(/MIN_LEAD_SECONDS/);
    }
  });
});

describe("fire times fall on the minute", () => {
  const post = async (path: string, body?: unknown) =>
    SELF.fetch(`${base}${path}`, {
      method: "POST",
      headers: body === undefined ? AUTH : JSON_AUTH,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("rounds a time with seconds up to the next minute, and leaves one on the minute as it is", () => {
    const minute = Date.UTC(2026, 8, 24, 12, 50);
    expect(onTheMinute(minute)).toBe(minute);
    expect(onTheMinute(minute + 1)).toBe(minute + 60_000);
    expect(onTheMinute(minute - 9_000)).toBe(minute);
    expect(onTheMinute(minute + 1_000)).toBe(minute + 60_000);
  });

  it("checks the lead on the time as requested, so rounding never lets a time inside it through", () => {
    const now = Date.UTC(2026, 8, 24, 12, 49, 10);
    // 59 s out would round to 12:51:00, 110 s out, but it was asked inside a one-minute lead.
    expect(() => acceptFireAt(now + 59_000, 60_000, { now })).toThrow(/at least 1 minute/);
    // Exactly the lead out is accepted, and stored on the minute after it: a longer window.
    expect(acceptFireAt(now + 60_000, 60_000, { now })).toBe(Date.UTC(2026, 8, 24, 12, 51));
  });

  it("stores schedule, Send now, and reschedule on the minute, and answers and reads back that time", async () => {
    const withSeconds = onTheMinute(Date.now() + 20 * 60_000) + 17_000;
    const scheduled = await post(`/api/posts/${await makeDraft()}/schedule`, {
      fire_at: new Date(withSeconds).toISOString(),
    });
    expect(scheduled.status).toBe(201);
    const { send } = await readJson(scheduled);
    expect(send.fire_at).toBe(withSeconds + 43_000);

    const moveTo = withSeconds + 30 * 60_000;
    const moved = await readJson(
      await post(`/api/sends/${send.id}/reschedule`, { fire_at: moveTo }),
    );
    expect(moved).toMatchObject({ changed: true, send: { fire_at: moveTo + 43_000 } });
    const read = await readJson(
      await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH }),
    );
    expect(read.send.fire_at).toBe(moveTo + 43_000);

    const now = await readJson(await post(`/api/posts/${await makeDraft()}/send`));
    expect(now.send.fire_at % 60_000).toBe(0);
    expect(now.send.fire_at).toBeGreaterThanOrEqual(
      now.send.scheduled_at + DEFAULT_MIN_LEAD_MS - 2000,
    );
  });

  it("keeps a time already on the minute exactly, on schedule and on reschedule", async () => {
    const onMinute = onTheMinute(Date.now() + 20 * 60_000);
    const { send } = await readJson(
      await post(`/api/posts/${await makeDraft()}/schedule`, { fire_at: onMinute }),
    );
    expect(send.fire_at).toBe(onMinute);
    const moved = await readJson(
      await post(`/api/sends/${send.id}/reschedule`, { fire_at: onMinute + 60 * 60_000 }),
    );
    expect(moved.send.fire_at).toBe(onMinute + 60 * 60_000);
  });

  it("refuses a schedule and a reschedule inside the lead, whatever minute they would round to", async () => {
    const id = await makeDraft();
    const refused = await post(`/api/posts/${id}/schedule`, {
      fire_at: Date.now() + DEFAULT_MIN_LEAD_MS - 1_000,
    });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).error).toBe("fire_at_too_soon");
    const { send } = await readJson(
      await post(`/api/posts/${id}/schedule`, { fire_at: Date.now() + 20 * 60_000 }),
    );
    const move = await post(`/api/sends/${send.id}/reschedule`, {
      fire_at: Date.now() + DEFAULT_MIN_LEAD_MS - 1_000,
    });
    expect(move.status).toBe(400);
    // A send already scheduled has no Send now to point to: the refusal says only the lead.
    expect(await readJson(move)).toMatchObject({
      error: "fire_at_too_soon",
      message: "Pick a time at least 5 minutes from now, so there’s time to cancel.",
      field: "fire_at",
    });
  });

  it("says in the API reference that the fire time is rounded up to the minute", async () => {
    const ref = await readJson(await SELF.fetch(`${base}/api/reference`, { headers: AUTH }));
    const routes = ref.groups.flatMap((g: any) => g.routes);
    for (const path of [
      "/api/posts/:id/schedule",
      "/api/posts/:id/send",
      "/api/sends/:id/reschedule",
    ]) {
      const route = routes.find((r: any) => r.path === path && r.method === "POST");
      expect(route?.description, path).toMatch(/rounded up to the next whole minute/);
    }
  });
});

describe("a send that may spend D1's daily writes (SPEC §8)", () => {
  // A new send also carries `untested` until a test lands; these tests are about the other.
  const writes = <T extends { kind: string }>(conditions: T[]) =>
    conditions.filter((c) => c.kind === "daily_writes");
  async function scheduleTo(recipients: number, vars: Record<string, string> = {}) {
    await seedConfirmed(addresses(recipients));
    const id = await makeDraft();
    const res = await fetchWith(vars, `${base}/api/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    expect(res.status).toBe(201);
    return (await readJson(res)).send;
  }

  it("is scheduled with a warning on Workers Free's limits, never refused, and every read carries it", async () => {
    const send = await scheduleTo(DAILY_WRITES_SEND_RECIPIENTS + 1);
    expect(writes(send.conditions)).toHaveLength(1);
    expect(send.conditions[0]).toMatchObject({
      severity: "warn",
      recipients: DAILY_WRITES_SEND_RECIPIENTS + 1,
      action: null,
    });
    const read = await readJson(
      await SELF.fetch(`${base}/api/sends/${send.id}`, { headers: AUTH }),
    );
    expect(writes(read.send.conditions)).toHaveLength(1);
    const feed = await readJson(await SELF.fetch(`${base}/api/sends/feed`, { headers: AUTH }));
    expect(
      writes<{ kind: string; send_id: string }>(feed.conditions).map((c) => [c.kind, c.send_id]),
    ).toEqual([["daily_writes", send.id]]);
  });

  it("counts what the day's imports wrote, so a smaller send warns on the day of an import", async () => {
    // Noon UTC, so the imports and the send share a day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utcDayStart(Date.now()) + 12 * 3_600_000);
    // Two imports of 1,000 new subscribers write 14,006 rows; a send to the 4,000 it leaves
    // writes 56,000 more, past the day's 70,000.
    for (const piece of [0, 1]) {
      const file = {
        name: `piece-${piece}.txt`,
        text: addresses(1_000)
          .map((e) => `p${piece}.${e}`)
          .join("\n"),
      };
      const plan = await readJson(
        await SELF.fetch(`${base}/api/imports/plan`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ file }),
        }),
      );
      const commit = await SELF.fetch(`${base}/api/imports`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          file,
          plan_hash: plan.plan_hash,
          attestation: { version: 1, accepted: true },
        }),
      });
      expect(commit.status).toBe(201);
    }
    const send = await scheduleTo(2_000);
    expect(writes(send.conditions)).toEqual([
      expect.objectContaining({
        kind: "daily_writes",
        recipients: 4_000,
        message:
          "On the Workers Free plan’s limits, a send to 4,000 recipients on the same day as today’s imports may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Send it tomorrow (UTC), or move to Workers Paid, which is recommended for a list of more than 5,000.",
      }),
    ]);
  });

  it("reaches a client following the feed, and the list, when an import lands after the send is scheduled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utcDayStart(Date.now()) + 12 * 3_600_000);
    const send = await scheduleTo(500); // 7,000 rows: fits the day on its own
    expect(writes(send.conditions)).toEqual([]);
    const first = await readJson(await SELF.fetch(`${base}/api/sends/feed`, { headers: AUTH }));
    // An earlier import today wrote 63,003 rows, recorded the way a commit records it.
    await env.DB.prepare(
      "INSERT INTO imports (id, created_at, principal_kind, principal_email, attestation_version, file_name, file_sha256, plan_hash, counts, suppressions_added) VALUES ('earlier', ?, 'service', NULL, 1, 'earlier.csv', 'sha', 'earlier-hash', ?, 0)",
    )
      .bind(
        Date.now() - 60_000,
        JSON.stringify({
          ...Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])),
          create_confirmed: 9_000,
        }),
      )
      .run();
    // Then an import commits now: one address recorded as unsubscribed, which grows no send.
    const file = { name: "left.txt", text: "gone@example.com\n" };
    const body = { file, plain_list_status: "unsubscribed" };
    const plan = await readJson(
      await SELF.fetch(`${base}/api/imports/plan`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(body),
      }),
    );
    const commit = await SELF.fetch(`${base}/api/imports`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ ...body, plan_hash: plan.plan_hash }),
    });
    expect(commit.status).toBe(201);
    const next = await readJson(
      await SELF.fetch(`${base}/api/sends/feed?since=${encodeURIComponent(first.cursor)}`, {
        headers: AUTH,
      }),
    );
    const followed = next.sends.find((s: { id: string }) => s.id === send.id);
    expect(writes(followed?.conditions ?? [])).toEqual([
      {
        kind: "daily_writes",
        severity: "warn",
        since: send.scheduled_at,
        message:
          "On the Workers Free plan’s limits, a send to 500 recipients on the same day as today’s imports may use up the database’s daily allowance of writes. That stops this newsletter until midnight UTC, the send included. Send it tomorrow (UTC), or move to Workers Paid, which is recommended for a list of more than 5,000.",
        action: null,
        recipients: 500,
      },
    ]);
    const list = await readJson(await SELF.fetch(`${base}/api/sends`, { headers: AUTH }));
    expect(writes(list.sends[0].conditions)).toHaveLength(1);
  });

  it("weighs a send alone on a day with no imports", async () => {
    expect(writes((await scheduleTo(4_000)).conditions)).toEqual([]);
  });

  it("carries no warning at the threshold, or on Workers Paid", async () => {
    expect(writes((await scheduleTo(DAILY_WRITES_SEND_RECIPIENTS)).conditions)).toEqual([]);
    await resetDatabase();
    const paid = await scheduleTo(DAILY_WRITES_SEND_RECIPIENTS + 1, { SUBREQUEST_BUDGET: "1000" });
    expect(writes(paid.conditions)).toEqual([]);
  });
});
