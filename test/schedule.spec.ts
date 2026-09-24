import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_LEAD_MS } from "../shared/sends";
import type { AppEnv } from "../src/env";
import worker from "../src/index";
import { cancel } from "../src/send/schedule";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);

async function makeDraft(markdown = "# Hi\n\nbody"): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: "The Subject", markdown }),
    }),
  );
  return created.post.id;
}

async function makeDraftWithSubject(subject: string): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject, markdown: "# Hi\n\nbody" }),
    }),
  );
  return created.post.id;
}

function future(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function postStatus(id: string): Promise<string> {
  const body = await readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
  return body.post.status;
}

describe("schedule / send / cancel + soft-lock", () => {
  it("schedules a future send, freezes the render, and locks the post (I3, I6)", async () => {
    const id = await makeDraft();
    const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.status).toBe("scheduled");
    expect(send.rendered_html).toContain("The Subject");
    expect(await postStatus(id)).toBe("scheduled");
  });

  it("soft-locks edits and image changes while scheduled (409)", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });

    const put = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "changed" }),
    });
    expect(put.status).toBe(409);

    const fd = new FormData();
    fd.append("file", new File([PNG_1x1], "x.png", { type: "image/png" }));
    const img = await SELF.fetch(`${base}/posts/${id}/images`, {
      method: "POST",
      headers: AUTH,
      body: fd,
    });
    expect(img.status).toBe(409);

    // second schedule while active → 409
    const again = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });
    expect(again.status).toBe(409);
  });

  it("rejects fire_at that isn't at least the buffer in the future (400)", async () => {
    const id = await makeDraft();
    for (const fire_at of [future(-1000), future(60 * 1000)]) {
      const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
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
      const id = await makeDraftWithSubject(subject);

      const sched = await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      });
      expect(sched.status).toBe(400);

      const now = await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH });
      expect(now.status).toBe(400);

      // neither attempt froze a send or locked the post
      expect(await postStatus(id)).toBe("draft");
    }
  });

  it("cancel unlocks the post; the frozen render is unchanged by later edits (I3)", async () => {
    const id = await makeDraft("original body");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const sendId = scheduled.send.id;
    const frozenHtml = scheduled.send.rendered_html;

    const cancel = await SELF.fetch(`${base}/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(cancel.status).toBe(200);
    expect(await postStatus(id)).toBe("draft");

    // edit is allowed again
    const put = await SELF.fetch(`${base}/posts/${id}`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({ markdown: "totally different body" }),
    });
    expect(put.status).toBe(200);

    // the canceled send's frozen bytes did not change
    const still = await readJson(await SELF.fetch(`${base}/sends/${sendId}`, { headers: AUTH }));
    expect(still.send.rendered_html).toBe(frozenHtml);
    expect(still.send.rendered_html).toContain("original body");

    // cancel again → 409
    const twice = await SELF.fetch(`${base}/sends/${sendId}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(twice.status).toBe(409);
  });

  it("cancel changes the send and the post together, or neither", async () => {
    const schedule = async (id: string) =>
      readJson(
        await SELF.fetch(`${base}/posts/${id}/schedule`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
        }),
      );
    const sendStatus = async (sendId: string) =>
      (await readJson(await SELF.fetch(`${base}/sends/${sendId}`, { headers: AUTH }))).send.status;

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
    await expect(cancel(env as AppEnv, sendingSend)).rejects.toThrow(/not cancelable/);
    expect(await sendStatus(sendingSend)).toBe("sending");
    expect(await postStatus(sending)).toBe("scheduled");
  });

  it("refuses a fire_at without a timezone (400 naming the field); offsets and epoch millis are accepted", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    const offsetless = at.toISOString().replace(/Z$/, "");
    for (const fire_at of [offsetless, offsetless.slice(0, 16), at.toISOString().slice(0, 10)]) {
      const id = await makeDraft();
      const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
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
      const res = await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(201);
      expect((await readJson(res)).send.fire_at).toBe(at.getTime());
    }

    // Reschedule reads fire_at the same way.
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const res = await SELF.fetch(`${base}/sends/${scheduled.send.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: offsetless }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("fire_at");
  });

  it("reschedules a scheduled send: moves fire_at, keeps the frozen render and the lock (I3, I6)", async () => {
    const id = await makeDraft("frozen body");
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    const sendId = scheduled.send.id;
    const frozenHtml = scheduled.send.rendered_html;

    const newFire = future(60 * 60 * 1000);
    const res = await SELF.fetch(`${base}/sends/${sendId}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: newFire }),
    });
    expect(res.status).toBe(200);
    const { send } = await readJson(res);
    // only the fire time moved: still scheduled, at the new time
    expect(send.status).toBe("scheduled");
    expect(send.fire_at).toBe(Date.parse(newFire));
    // the frozen render and audience are untouched — no re-freeze (I3)
    expect(send.rendered_html).toBe(frozenHtml);
    expect(send.rendered_html).toContain("frozen body");
    expect(send.recipient_count).toBe(scheduled.send.recipient_count);
    // scheduled_at is the review window's anchor: preserved, not reset — the window is
    // moved, not restarted (I6, SPEC §6 "Moving the fire time")
    expect(send.scheduled_at).toBe(scheduled.send.scheduled_at);
    // the post stays soft-locked (still scheduled) — reschedule never unlocks (I6)
    expect(await postStatus(id)).toBe("scheduled");
    // still the post's one active send, now at the new time
    const still = await readJson(await SELF.fetch(`${base}/sends/${sendId}`, { headers: AUTH }));
    expect(still.send.fire_at).toBe(Date.parse(newFire));
  });

  it("rejects a reschedule fire_at that isn't at least the buffer out (400), leaving the time unchanged", async () => {
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    for (const fire_at of [future(-1000), future(60 * 1000)]) {
      const res = await SELF.fetch(`${base}/sends/${scheduled.send.id}/reschedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at }),
      });
      expect(res.status).toBe(400);
    }
    const still = await readJson(
      await SELF.fetch(`${base}/sends/${scheduled.send.id}`, { headers: AUTH }),
    );
    expect(still.send.fire_at).toBe(scheduled.send.fire_at);
  });

  it("won't reschedule a send that's no longer scheduled (409)", async () => {
    const id = await makeDraft();
    const scheduled = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    await SELF.fetch(`${base}/sends/${scheduled.send.id}/cancel`, {
      method: "POST",
      headers: AUTH,
    });

    const res = await SELF.fetch(`${base}/sends/${scheduled.send.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(30 * 60 * 1000) }),
    });
    expect(res.status).toBe(409);
  });

  it("404s rescheduling an unknown send, and requires auth", async () => {
    const known = future(30 * 60 * 1000);
    const missing = await SELF.fetch(`${base}/sends/does-not-exist/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: known }),
    });
    expect(missing.status).toBe(404);

    const noauth = await SELF.fetch(`${base}/sends/does-not-exist/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fire_at: known }),
    });
    expect(noauth.status).toBe(401);
  });

  it("snapshots recipient_count at schedule time", async () => {
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
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    expect(send.recipient_count).toBe(3);
  });

  it("send-now schedules at now + buffer and is idempotent", async () => {
    const id = await makeDraft();
    const first = await readJson(
      await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(first.send.status).toBe("scheduled");
    expect(
      Math.abs(first.send.fire_at - first.send.scheduled_at - DEFAULT_MIN_LEAD_MS),
    ).toBeLessThan(2000);

    const second = await readJson(
      await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH }),
    );
    expect(second.idempotent).toBe(true);
    expect(second.send.id).toBe(first.send.id);
  });

  it("refuses a stray template_revision on schedule and send-now (400): a send is made with the template as it stands", async () => {
    const id = await makeDraft();
    const sched = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000), template_revision: "tr_1" }),
    });
    expect(sched.status).toBe(400);
    const now = await SELF.fetch(`${base}/posts/${id}/send`, {
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
      SELF.fetch(`${base}/posts/${id}/schedule`, {
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

  it("re-schedules a post after its prior send is canceled (predicate excludes terminal states)", async () => {
    const id = await makeDraft();
    const first = await readJson(
      await SELF.fetch(`${base}/posts/${id}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
      }),
    );
    await SELF.fetch(`${base}/sends/${first.send.id}/cancel`, { method: "POST", headers: AUTH });

    // The canceled send is out of the active set, so a fresh schedule succeeds.
    const again = await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });
    expect(again.status).toBe(201);
    expect((await readJson(again)).send.id).not.toBe(first.send.id);
  });

  it("lists sends and requires auth", async () => {
    const id = await makeDraft();
    await SELF.fetch(`${base}/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    const list = await readJson(await SELF.fetch(`${base}/sends`, { headers: AUTH }));
    expect(list.sends.length).toBeGreaterThanOrEqual(1);
    // The list row carries the denormalized progress counters (`sends.c_*`) instead of
    // the per-row deliveryRollup aggregate it once ran (#166) — the client derives the
    // dispatch/delivery/wedged view straight off them.
    expect(list.sends[0]).toHaveProperty("c_delivered");
    expect(list.sends[0]).toHaveProperty("c_bounced");
    expect(list.sends[0]).toHaveProperty("c_pending");
    expect(list.sends[0]).not.toHaveProperty("progress");

    const noauth = await SELF.fetch(`${base}/sends`);
    expect(noauth.status).toBe(401);
  });

  it("sends list carries a page envelope and honors the status filter + sort", async () => {
    // Two scheduled sends with different fire times.
    const idA = await makeDraft();
    await SELF.fetch(`${base}/posts/${idA}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(10 * 60 * 1000) }),
    });
    const idB = await makeDraft();
    await SELF.fetch(`${base}/posts/${idB}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: future(20 * 60 * 1000) }),
    });

    const list = await readJson(
      await SELF.fetch(`${base}/sends?status=scheduled&sort=fire&dir=asc&limit=100`, {
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

  /** A request to the Worker under this suite's env with some vars overridden, as another
   *  deployment's own config would set them. */
  async function fetchWith(
    vars: Record<string, string>,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${base}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
      { ...env, ...vars } as unknown as AppEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  const scheduleAt = (vars: Record<string, string>, id: string, fire_at: string) =>
    fetchWith(vars, `/posts/${id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at }),
    });

  it("schedules as close as the configured lead allows, and refuses closer, naming the lead", async () => {
    const id = await makeDraft();
    const tooClose = await scheduleAt(MINUTE_LEAD, id, future(30 * 1000));
    expect(tooClose.status).toBe(400);
    expect((await readJson(tooClose)).message).toMatch(/at least 1 minute in the future/);

    // Ninety seconds out: inside the default five minutes, outside a one-minute lead.
    const underDefault = await scheduleAt({}, id, future(90 * 1000));
    expect(underDefault.status).toBe(400);
    expect((await readJson(underDefault)).message).toMatch(/at least 5 minutes in the future/);
    const ok = await scheduleAt(MINUTE_LEAD, id, future(90 * 1000));
    expect(ok.status).toBe(201);
    expect(await postStatus(id)).toBe("scheduled");
  });

  it("sends now at one configured lead out", async () => {
    const id = await makeDraft();
    const res = await fetchWith(MINUTE_LEAD, `/posts/${id}/send`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(Math.abs(send.fire_at - send.scheduled_at - 60_000)).toBeLessThan(2000);
  });

  it("reschedules as close as the configured lead allows, and no closer", async () => {
    const id = await makeDraft();
    const { send } = await readJson(await scheduleAt({}, id, future(10 * 60 * 1000)));
    const move = (vars: Record<string, string>, fire_at: string) =>
      fetchWith(vars, `/sends/${send.id}/reschedule`, {
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
    for (const path of ["/posts/:id/schedule", "/posts/:id/send", "/sends/:id/reschedule"]) {
      const route = routes.find((r: any) => r.path === path && r.method === "POST");
      expect(route?.description, path).toMatch(/1 minute on this deployment/);
      expect(route?.description, path).toMatch(/MIN_LEAD_SECONDS/);
    }
  });
});
