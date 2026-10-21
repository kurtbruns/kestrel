import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { SendView } from "../shared/sends";
import type { Actor } from "../shared/who_acted";
import { DEV_TOKEN_ID } from "../src/auth/dev_token";
import * as sends from "../src/db/sends";
import { frozenSend, resetDatabase, wedgedSend } from "./support/fixtures";
import { adminAuth, base, readJson } from "./support/http";

// Who acted on a send (SPEC §6, §11): each act that changes a send records the person or the
// service token behind it, with the client a person came through, and every read of the send
// shows it. The latest of each act is kept; an act that changes nothing records no one.

beforeEach(resetDatabase);

/** Who acts, as the request's credential and `Kestrel-Client` say, and what the send records. */
interface Who {
  name: string;
  auth: { email?: string; client?: string };
  actor: Actor;
}

const EDITOR: Who = {
  name: "a person in the editor",
  auth: { email: "you@example.com", client: "editor" },
  actor: { kind: "human", email: "you@example.com", client: "editor" },
};
const CLAUDE_CODE: Who = {
  name: "a person via Claude Code",
  auth: { email: "you@example.com", client: "claude-code" },
  actor: { kind: "human", email: "you@example.com", client: "claude-code" },
};
const NO_CLIENT: Who = {
  name: "a person through a client that names nothing",
  auth: { email: "you@example.com" },
  actor: { kind: "human", email: "you@example.com", client: null },
};
const SERVICE: Who = {
  name: "a service token",
  // The client's name on a service token's request changes nothing.
  auth: { client: "claude-code" },
  actor: { kind: "service", token_id: DEV_TOKEN_ID, client: null },
};
const EVERYONE = [EDITOR, CLAUDE_CODE, NO_CLIENT, SERVICE];

async function call(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  const headers = await adminAuth(who.auth);
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A draft, made in the editor, its id. */
async function draft(): Promise<string> {
  const res = await call(EDITOR, "POST", "/api/posts", { subject: "S", markdown: "# Hi" });
  return (await readJson(res)).post.id;
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const inTwoHours = () => new Date(Date.now() + 7_200_000).toISOString();

/** A send's view as `GET /api/sends/:id` reads it. */
async function view(id: string): Promise<SendView> {
  return (await readJson(await call(EDITOR, "GET", `/api/sends/${id}`))).send;
}

/** Who acted on a send, as its view reports each act. */
const actedBy = (v: SendView) => ({
  scheduled_by: v.scheduled_by,
  rescheduled_by: v.rescheduled_by,
  canceled_by: v.canceled_by,
  resolved_by: v.resolved_by,
});

/** A scheduled send, made by `who`, its id. */
async function scheduled(who: Who): Promise<string> {
  const res = await call(who, "POST", `/api/posts/${await draft()}/schedule`, {
    fire_at: inAnHour(),
  });
  expect(res.status).toBe(201);
  return (await readJson(res)).send.id;
}

describe("a send records who acted on it (SPEC §6, §11)", () => {
  for (const who of EVERYONE) {
    it(`records ${who.name} as who scheduled it, and answers it on the schedule`, async () => {
      const res = await call(who, "POST", `/api/posts/${await draft()}/schedule`, {
        fire_at: inAnHour(),
      });
      const send: SendView = (await readJson(res)).send;
      expect(send.scheduled_by).toEqual(who.actor);
      expect(actedBy(await view(send.id))).toEqual({
        scheduled_by: who.actor,
        rescheduled_by: null,
        canceled_by: null,
        resolved_by: null,
      });
    });

    it(`records ${who.name} as who sent it now`, async () => {
      const res = await call(who, "POST", `/api/posts/${await draft()}/send`);
      expect(res.status).toBe(201);
      const id: string = (await readJson(res)).send.id;
      expect((await view(id)).scheduled_by).toEqual(who.actor);
    });

    it(`records ${who.name} as who moved it`, async () => {
      const id = await scheduled(EDITOR);
      const res = await call(who, "POST", `/api/sends/${id}/reschedule`, { fire_at: inTwoHours() });
      expect((await readJson(res)).send.rescheduled_by).toEqual(who.actor);
      expect(actedBy(await view(id))).toEqual({
        scheduled_by: EDITOR.actor,
        rescheduled_by: who.actor,
        canceled_by: null,
        resolved_by: null,
      });
    });

    it(`records ${who.name} as who canceled it`, async () => {
      const id = await scheduled(EDITOR);
      const res = await call(who, "POST", `/api/sends/${id}/cancel`);
      expect((await readJson(res)).send.canceled_by).toEqual(who.actor);
      expect(actedBy(await view(id))).toEqual({
        scheduled_by: EDITOR.actor,
        rescheduled_by: null,
        canceled_by: who.actor,
        resolved_by: null,
      });
    });

    it(`records ${who.name} as who resolved it while wedged`, async () => {
      const id = await wedgedSend();
      const res = await call(who, "POST", `/api/sends/${id}/resolve`, { resolution: "unsent" });
      expect(res.status).toBe(200);
      expect((await readJson(res)).send.resolved_by).toEqual(who.actor);
      expect((await view(id)).resolved_by).toEqual(who.actor);
    });
  }

  it("keeps each act's actor apart, and the latest of each", async () => {
    const id = await scheduled(SERVICE);
    await call(CLAUDE_CODE, "POST", `/api/sends/${id}/reschedule`, { fire_at: inTwoHours() });
    await call(NO_CLIENT, "POST", `/api/sends/${id}/reschedule`, { fire_at: inAnHour() });
    await call(EDITOR, "POST", `/api/sends/${id}/cancel`);
    expect(actedBy(await view(id))).toEqual({
      scheduled_by: SERVICE.actor,
      rescheduled_by: NO_CLIENT.actor,
      canceled_by: EDITOR.actor,
      resolved_by: null,
    });
  });

  it("records no one for an act that changes nothing", async () => {
    const id = await scheduled(EDITOR);
    const fireAt = (await view(id)).fire_at;
    // A move to the time it already has.
    await call(CLAUDE_CODE, "POST", `/api/sends/${id}/reschedule`, { fire_at: fireAt });
    expect((await view(id)).rescheduled_by).toBeNull();
    // A cancel repeated keeps who canceled it first.
    await call(EDITOR, "POST", `/api/sends/${id}/cancel`);
    await call(SERVICE, "POST", `/api/sends/${id}/cancel`);
    expect((await view(id)).canceled_by).toEqual(EDITOR.actor);
    // A repeated Send now answers the send it made, and keeps who made it.
    const post = await draft();
    const first = (await readJson(await call(EDITOR, "POST", `/api/posts/${post}/send`))).send;
    const repeat = await readJson(await call(SERVICE, "POST", `/api/posts/${post}/send`));
    expect(repeat.idempotent).toBe(true);
    expect(repeat.send.scheduled_by).toEqual(EDITOR.actor);
    expect((await view(first.id)).scheduled_by).toEqual(EDITOR.actor);
  });

  it("records no one for a refused act", async () => {
    const id = await scheduled(EDITOR);
    const tooSoon = new Date(Date.now() + 1000).toISOString();
    const res = await call(SERVICE, "POST", `/api/sends/${id}/reschedule`, { fire_at: tooSoon });
    expect((await readJson(res)).error).toBe("fire_at_too_soon");
    expect((await view(id)).rescheduled_by).toBeNull();
  });

  it("records no one for a cancel after the window closed", async () => {
    const id = await scheduled(EDITOR);
    // Its fire time has passed, so the window is closed whether or not the sweep has started it.
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() - 60_000, id)
      .run();
    const res = await call(SERVICE, "POST", `/api/sends/${id}/cancel`);
    expect((await readJson(res)).error).toBe("window_closed");
    expect((await view(id)).canceled_by).toBeNull();
  });

  it("records no one for a Resolve on a send that isn't wedged", async () => {
    const id = await scheduled(EDITOR);
    const res = await call(SERVICE, "POST", `/api/sends/${id}/resolve`, { resolution: "unsent" });
    expect((await readJson(res)).error).toBe("not_wedged");
    expect((await view(id)).resolved_by).toBeNull();
  });

  it("shows who acted on every read of the send: the list and the feed as well", async () => {
    const before = (await readJson(await call(EDITOR, "GET", "/api/sends"))).cursor;
    const id = await scheduled(CLAUDE_CODE);
    const list = await readJson(await call(EDITOR, "GET", "/api/sends"));
    expect(list.sends.map((s: SendView) => [s.id, s.scheduled_by])).toEqual([
      [id, CLAUDE_CODE.actor],
    ]);
    const feed = await readJson(await call(EDITOR, "GET", `/api/sends/feed?since=${before}`));
    expect(feed.sends.map((s: SendView) => [s.id, s.scheduled_by])).toEqual([
      [id, CLAUDE_CODE.actor],
    ]);
  });

  it("reads a send no act was recorded on as acted on by no one", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    expect(actedBy(await view(send.id))).toEqual({
      scheduled_by: null,
      rescheduled_by: null,
      canceled_by: null,
      resolved_by: null,
    });
  });

  it("keeps every act in the send's log, with when, and the time or resolution it set", async () => {
    const id = await scheduled(EDITOR);
    await call(CLAUDE_CODE, "POST", `/api/sends/${id}/reschedule`, { fire_at: inTwoHours() });
    await call(SERVICE, "POST", `/api/sends/${id}/reschedule`, { fire_at: inAnHour() });
    await call(EDITOR, "POST", `/api/sends/${id}/cancel`);
    const { results } = await env.DB.prepare(
      "SELECT act, at, actor, fire_at, resolution FROM send_acts WHERE send_id = ? ORDER BY id",
    )
      .bind(id)
      .all<{ act: string; at: number; actor: string; fire_at: number | null }>();
    const send = await view(id);
    expect(results.map((r) => [r.act, JSON.parse(r.actor)])).toEqual([
      ["schedule", EDITOR.actor],
      ["reschedule", CLAUDE_CODE.actor],
      ["reschedule", SERVICE.actor],
      ["cancel", EDITOR.actor],
    ]);
    // The last move set the time the send was canceled at; a cancel sets none.
    expect(results.map((r) => r.fire_at).slice(2)).toEqual([send.fire_at, null]);
    expect(results[3]?.at).toBe(send.completed_at);
    expect(results.every((r, i) => i === 0 || r.at >= (results[i - 1]?.at ?? 0))).toBe(true);
  });

  it("tells a Send now apart from a schedule in the log, and a Resolve by its resolution", async () => {
    const res = await call(CLAUDE_CODE, "POST", `/api/posts/${await draft()}/send`);
    const sent = (await readJson(res)).send;
    const wedgedId = await wedgedSend();
    await call(SERVICE, "POST", `/api/sends/${wedgedId}/resolve`, { resolution: "accepted" });
    const { results } = await env.DB.prepare(
      "SELECT send_id, act, fire_at, resolution FROM send_acts ORDER BY id",
    ).all();
    expect(results).toEqual([
      { send_id: sent.id, act: "send_now", fire_at: sent.fire_at, resolution: null },
      { send_id: wedgedId, act: "resolve", fire_at: null, resolution: "accepted" },
    ]);
  });

  it("deletes a deleted draft's log of acts with its canceled sends", async () => {
    const post = await draft();
    const res = await call(EDITOR, "POST", `/api/posts/${post}/schedule`, { fire_at: inAnHour() });
    await call(EDITOR, "POST", `/api/sends/${(await readJson(res)).send.id}/cancel`);
    expect((await call(EDITOR, "DELETE", `/api/posts/${post}`)).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM send_acts").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

// Each act lands in the log only with the change it records: the guard each record statement
// carries is what holds that, in the same batch, after the change. These run a change that the
// database refuses (the JS checks before the batch never see it), so only the guard stops the act.
describe("the log records an act only when its change landed (SPEC §6)", () => {
  const BY: Actor = { kind: "human", email: "you@example.com", client: "editor" };
  const actsOf = async (sendId: string) =>
    (
      await env.DB.prepare("SELECT act, resolution FROM send_acts WHERE send_id = ? ORDER BY id")
        .bind(sendId)
        .all<{ act: string; resolution: string | null }>()
    ).results;

  it("records no reschedule when the window has closed under it", async () => {
    const send = await frozenSend(Date.now() - 60_000);
    const now = Date.now();
    const target = now + 3_600_000;
    const [res] = await env.DB.batch([
      sends.rescheduleStmt(env.DB, send.id, target, now),
      sends.recordActStmt(
        env.DB,
        { sendId: send.id, act: "reschedule", at: now, by: BY, fireAt: target },
        sends.rescheduledTo(send.id, target),
      ),
    ]);
    expect(res?.meta.changes).toBe(0);
    expect(await actsOf(send.id)).toEqual([]);
  });

  it("records no cancel when the window has closed under it", async () => {
    const send = await frozenSend(Date.now() - 60_000);
    const now = Date.now();
    const [res] = await env.DB.batch([
      sends.cancelStmt(env.DB, send.id, now),
      sends.recordActStmt(
        env.DB,
        { sendId: send.id, act: "cancel", at: now, by: BY },
        sends.canceledAt(send.id, now),
      ),
    ]);
    expect(res?.meta.changes).toBe(0);
    expect(await actsOf(send.id)).toEqual([]);
  });

  it("records no schedule when the freeze's insert was refused", async () => {
    const other = await frozenSend(Date.now() + 3_600_000);
    await sends.cancelStmt(env.DB, other.id, Date.now()).run(); // its post is free to schedule
    const now = Date.now();
    const id = "s-refused";
    // A settings version that isn't the current one, as when a template save lands mid-freeze.
    const res = await env.DB.batch([
      sends.insertScheduledSendStmt(
        env.DB,
        {
          id,
          post_id: other.post_id,
          fire_at: now + 3_600_000,
          recipient_count: 0,
          rendered_html: "",
          rendered_text: "",
          subject: "S",
          warnings: [],
        },
        now,
        -1,
      ),
      sends.recordActStmt(
        env.DB,
        { sendId: id, act: "schedule", at: now, by: BY, fireAt: now + 3_600_000 },
        sends.sendExists(id),
      ),
    ]);
    expect(res[0]?.meta.changes).toBe(0);
    expect(await actsOf(id)).toEqual([]);
  });

  it("records one Resolve when two race, though the second held the lease", async () => {
    const id = await wedgedSend();
    const a = await sends.acquireLease(env.DB, id, Date.now(), 60_000);
    expect(a).not.toBeNull();
    const first = await sends.resolveDispatched(env.DB, id, a ?? "", "unsent", "a", Date.now(), BY);
    expect(first).toBe(1);
    await sends.releaseLease(env.DB, id, a ?? "");
    // The second passed its wedged check before the first settled the rows, and now takes the
    // lease with nothing left to settle.
    const b = await sends.acquireLease(env.DB, id, Date.now(), 60_000);
    expect(b).not.toBeNull();
    const second = await sends.resolveDispatched(
      env.DB,
      id,
      b ?? "",
      "accepted",
      "b",
      Date.now(),
      BY,
    );
    expect(second).toBe(0);
    expect(await actsOf(id)).toEqual([{ act: "resolve", resolution: "unsent" }]);
  });

  it("records no Resolve without the lease", async () => {
    const id = await wedgedSend();
    const moved = await sends.resolveDispatched(
      env.DB,
      id,
      "not-the-lease",
      "unsent",
      "x",
      Date.now(),
      BY,
    );
    expect(moved).toBe(0);
    expect(await actsOf(id)).toEqual([]);
  });
});
