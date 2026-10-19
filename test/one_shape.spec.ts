import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsContention, updateSettings } from "../src/db/settings";
import * as subs from "../src/db/subscribers";
import { type AppEnv, getConfig } from "../src/env";
import { HttpError } from "../src/lib/errors";
import type { RequestContext } from "../src/router";
import * as postRoutes from "../src/routes/posts";
import { carryingSettings } from "../src/routes/settings";
import { postActions } from "../src/services/post_view";
import { NOT_CONNECTED_DEPLOY } from "./support/deploy";
import { resetDatabase, setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { fetchOn, withVars } from "./support/worker_env";

// One shape per noun (docs/API.md, principles 2, 3, and 5): a post and a subscriber read the
// same on every route that carries them, a post says where its send stands as the send's own
// view and what can be done to it, and a refusal about state carries the resource as it stands.

const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
  SELF.fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? AUTH : JSON_AUTH,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const DRAFT_ACTIONS = (id: string) => [
  { name: "edit", method: "PUT", path: `/api/posts/${id}` },
  { name: "delete", method: "DELETE", path: `/api/posts/${id}` },
  { name: "schedule", method: "POST", path: `/api/posts/${id}/schedule` },
  { name: "send_now", method: "POST", path: `/api/posts/${id}/send` },
];

/** The post as `GET /api/posts/:id` and as the list read it. */
async function bothReads(id: string) {
  const one = (await readJson(await call(`/api/posts/${id}`))).post;
  const list = (await readJson(await call("/api/posts?status=draft,scheduled,sent"))).posts;
  return { one, row: list.find((p: { id: string }) => p.id === id) };
}

describe("a post reads the same on every route, with its send and its actions (SPEC §6, §8)", () => {
  beforeEach(resetDatabase);

  it("carries its send as the send's own view through each state, and what the server would take", async () => {
    const { post } = await readJson(
      await call("/api/posts", { method: "POST", body: { subject: "Owls", markdown: "# Hi" } }),
    );
    // A draft: no send, and all four acts.
    expect([post.send, post.actions]).toEqual([null, DRAFT_ACTIONS(post.id)]);
    let { one, row } = await bothReads(post.id);
    expect(Object.keys(row).sort()).toEqual(Object.keys(one).sort());
    expect([one.send, one.actions]).toEqual([null, DRAFT_ACTIONS(post.id)]);

    // Scheduled: the send as `GET /api/sends/:id` answers it, and nothing to do to the post.
    const fire_at = Date.now() + 3_600_000;
    const sched = await readJson(
      await call(`/api/posts/${post.id}/schedule`, { method: "POST", body: { fire_at } }),
    );
    const sendId = sched.send.id;
    const { send } = await readJson(await call(`/api/sends/${sendId}`));
    ({ one, row } = await bothReads(post.id));
    for (const p of [one, row]) {
      expect({ ...p.send, as_of: 0 }).toEqual({ ...send, as_of: 0 });
      expect(p.actions).toEqual([]);
    }
    // A settings change answers the same post.
    const settings = await readJson(
      await call(`/api/posts/${post.id}/settings`, { method: "PUT", body: { email_only: true } }),
    );
    expect(Object.keys(settings.post).sort()).toEqual(Object.keys(one).sort());
    expect(settings.post.send.id).toBe(sendId);

    // Canceled: a draft again, with no send, since a canceled send is no post's send.
    await call(`/api/sends/${sendId}/cancel`, { method: "POST" });
    ({ one } = await bothReads(post.id));
    expect([one.status, one.send, one.actions]).toEqual(["draft", null, DRAFT_ACTIONS(post.id)]);

    // Sent: the send that sent it.
    const again = await readJson(
      await call(`/api/posts/${post.id}/schedule`, { method: "POST", body: { fire_at } }),
    );
    await setRow(again.send.id, {
      status: "sent",
      started_at: Date.now(),
      completed_at: Date.now(),
    });
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(post.id).run();
    ({ one, row } = await bothReads(post.id));
    for (const p of [one, row]) {
      expect([p.status, p.send?.id, p.send?.status, p.actions]).toEqual([
        "sent",
        again.send.id,
        "sent",
        [],
      ]);
    }
  });

  it("offers schedule and send now only while a provider is connected (SPEC §9)", async () => {
    const draft = { id: "p1", status: "draft" } as const;
    expect(postActions(draft, getConfig(env)).map((a) => a.name)).toEqual([
      "edit",
      "delete",
      "schedule",
      "send_now",
    ]);
    expect(postActions(draft, { provider: "none" }).map((a) => a.name)).toEqual(["edit", "delete"]);
    // Through the route, under a deployment with no provider.
    const { post } = await readJson(await call("/api/posts", { method: "POST", body: {} }));
    const e = withVars(NOT_CONNECTED_DEPLOY);
    const req = new Request(`${base}/api/posts/${post.id}`);
    const c = {
      req,
      env: e,
      ctx: createExecutionContext(),
      url: new URL(req.url),
      params: { id: post.id },
      config: getConfig(e),
      principal: { kind: "human", email: "tester@example.com", via: "access" },
    } as unknown as RequestContext;
    const read = await readJson(await postRoutes.getPost(c));
    expect(read.post.actions.map((a: { name: string }) => a.name)).toEqual(["edit", "delete"]);
  });
});

describe("a subscriber carries its suppression on every route (SPEC §7)", () => {
  beforeEach(resetDatabase);

  it("reads the same alone, by address, in the list, and after an unsubscribe", async () => {
    const email = "reader@example.com";
    const { subscriber } = await subs.ensureSubscriber(env.DB, email);
    await subs.addSuppression(env.DB, email, "bounce", "mailbox gone");
    const since = await env.DB.prepare("SELECT created_at FROM suppressions WHERE email = ?")
      .bind(email)
      .first<{ created_at: number }>();
    const suppression = { reason: "bounce", detail: "mailbox gone", created_at: since!.created_at };
    const answers = [
      (await readJson(await call(`/api/subscribers/${subscriber.id}`))).subscriber,
      (await readJson(await call(`/api/subscribers?email=${email}`))).subscriber,
      (await readJson(await call("/api/subscribers"))).subscribers[0],
      (
        await readJson(
          await call(`/api/subscribers/${subscriber.id}/unsubscribe`, { method: "POST" }),
        )
      ).subscriber,
    ];
    for (const s of answers) {
      expect([s.email, s.suppression]).toEqual([email, suppression]);
      expect(Object.keys(s).sort()).toEqual(Object.keys(answers[0]).sort());
    }
    // Beside nothing: the answer is the subscriber, not a second copy of its suppression.
    expect(Object.keys(await readJson(await call(`/api/subscribers/${subscriber.id}`)))).toEqual([
      "subscriber",
    ]);
  });
});

describe("a refusal about the settings' state carries the settings as they stand", () => {
  beforeEach(resetDatabase);

  it("adds them to a conflict, so a client redraws before it tries again", async () => {
    await updateSettings(env.DB, { test_recipients: ["me@example.com"] });
    const c = { env, config: getConfig(env) } as unknown as RequestContext;
    const err = await carryingSettings(c, async () => {
      throw new SettingsContention();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect([(err as HttpError).code, (err as HttpError).details?.settings]).toMatchObject([
      "conflict",
      { test_recipients: ["me@example.com"] },
    ]);
  });

  it("adds them to settings_changed, thrown when the settings move under every try of a freeze", async () => {
    await updateSettings(env.DB, { test_recipients: ["me@example.com"] });
    const { post } = await readJson(
      await call("/api/posts", { method: "POST", body: { subject: "Owls", markdown: "# Hi" } }),
    );
    // A D1 handle on which another writer saves the settings just before each of the freeze's
    // batches, so every try renders against settings that have moved by the time it lands.
    const db = env.DB;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await db.prepare("UPDATE settings SET updated_at = updated_at + 1 WHERE id = 1").run();
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await fetchOn({ ...env, DB: racing } as AppEnv, `/api/posts/${post.id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: Date.now() + 3_600_000 }),
    });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      error: "settings_changed",
      settings: { test_recipients: ["me@example.com"] },
    });
  });
});
