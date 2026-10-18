import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { PostAction } from "../shared/posts";
import { getConfig } from "../src/env";
import type { RequestContext } from "../src/router";
import * as postRoutes from "../src/routes/posts";
import * as scheduleRoutes from "../src/routes/schedule";
import { NOT_CONNECTED_DEPLOY } from "./support/deploy";
import { resetDatabase, setRow } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { withVars } from "./support/worker_env";

// A post's `actions` say exactly what the server would take now (docs/API.md, principle 3).
// For each state a post can be in, every act a post can have is tried against the server as
// its method and path say: an offered act is accepted, and a withheld one is not.

const ALL: PostAction["name"][] = ["edit", "delete", "schedule", "send_now"];

/** Each act's request, as the post's action names it, with the body it needs. */
function requestFor(name: PostAction["name"], post: { id: string; current_revision: string }) {
  const path = `/api/posts/${post.id}`;
  switch (name) {
    case "edit":
      return {
        method: "PUT",
        path,
        body: { markdown: "Edited.", base_revision: post.current_revision },
      };
    case "delete":
      return { method: "DELETE", path };
    case "schedule":
      return {
        method: "POST",
        path: `${path}/schedule`,
        body: { fire_at: Date.now() + 3_600_000 },
      };
    case "send_now":
      return { method: "POST", path: `${path}/send` };
  }
}

const call = (req: { method: string; path: string; body?: unknown }) =>
  SELF.fetch(`${base}${req.path}`, {
    method: req.method,
    headers: req.body === undefined ? AUTH : JSON_AUTH,
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  });

async function newDraft(markdown = "# Hi"): Promise<string> {
  const { post } = await readJson(
    await call({ method: "POST", path: "/api/posts", body: { subject: "Owls", markdown } }),
  );
  return post.id;
}

const readPost = async (id: string) =>
  (await readJson(await call({ method: "GET", path: `/api/posts/${id}` }))).post;

// Going out: the post stays `scheduled` while its send is `sending`.
async function sending(): Promise<string> {
  const id = await newDraft();
  const { send } = await readJson(await call(requestFor("schedule", { id, current_revision: "" })));
  await setRow(send.id, { status: "sending", started_at: Date.now() });
  return id;
}

/** The states a post can be in, each made fresh, since an act changes the post it acts on. */
const STATES: Record<string, () => Promise<string>> = {
  draft: () => newDraft(),
  // An empty body is warned about, not blocked (SPEC §6), so it offers every act too.
  "draft with an empty body": () => newDraft(""),
  scheduled: async () => {
    const id = await newDraft();
    await call(requestFor("schedule", { id, current_revision: "" }));
    return id;
  },
  sending,

  sent: async () => {
    const id = await newDraft();
    const { send } = await readJson(
      await call(requestFor("schedule", { id, current_revision: "" })),
    );
    await setRow(send.id, { status: "sent", started_at: Date.now(), completed_at: Date.now() });
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(id).run();
    return id;
  },
  "draft back from a canceled send": async () => {
    const id = await newDraft();
    const { send } = await readJson(
      await call(requestFor("schedule", { id, current_revision: "" })),
    );
    await call({ method: "POST", path: `/api/sends/${send.id}/cancel` });
    return id;
  },
};

describe("a post's actions are exactly what the server takes (SPEC §6)", () => {
  beforeEach(resetDatabase);

  for (const [state, make] of Object.entries(STATES)) {
    it(`${state}: each offered act is accepted, each withheld one is not`, async () => {
      const offered = (await readPost(await make())).actions.map((a: PostAction) => a.name);
      for (const name of ALL) {
        const post = await readPost(await make());
        const res = await call(requestFor(name, post));
        const body = await readJson(res);
        if (offered.includes(name)) {
          expect(res.ok, `${state}: ${name} offered, answered ${res.status} ${body.error}`).toBe(
            true,
          );
          expect(
            body.idempotent,
            `${state}: ${name} offered, answered as a repeat`,
          ).toBeUndefined();
        } else {
          // Withheld: refused, or, for a send now on a post already going out, answered as the
          // repeat it is (`idempotent`), which sends nothing new (docs/API.md, principle 4).
          const declined = !res.ok || body.idempotent === true;
          expect(declined, `${state}: ${name} withheld, answered ${res.status}`).toBe(true);
        }
      }
    });
  }

  it("sending: carries the send going out, and offers nothing", async () => {
    const post = await readPost(await sending());
    expect([post.status, post.send?.status, post.actions]).toEqual(["scheduled", "sending", []]);
  });

  it("not connected: edit and delete are accepted, and schedule and send now are refused", async () => {
    const id = await newDraft();
    const e = withVars(NOT_CONNECTED_DEPLOY);
    // Called directly: off the fake, the env is no longer dev-shaped, so the suite's dev
    // token no longer authenticates through the router.
    const context = (req: { method: string; path: string; body?: unknown }): RequestContext => {
      const request = new Request(`${base}${req.path}`, {
        method: req.method,
        ...(req.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) }),
      });
      return {
        req: request,
        env: e,
        ctx: createExecutionContext(),
        url: new URL(request.url),
        params: { id },
        config: getConfig(e),
        principal: { kind: "human", email: "tester@example.com", via: "access" },
      } as unknown as RequestContext;
    };
    const handlers = {
      edit: postRoutes.updatePost,
      delete: postRoutes.deletePost,
      schedule: scheduleRoutes.schedule,
      send_now: scheduleRoutes.sendNow,
    };
    const read = await readJson(await postRoutes.getPost(context({ method: "GET", path: "" })));
    const offered = read.post.actions.map((a: PostAction) => a.name);
    expect(offered).toEqual(["edit", "delete"]);
    for (const name of ["schedule", "send_now", "edit", "delete"] as const) {
      const post = await readPost(id);
      const outcome = await handlers[name](context(requestFor(name, post))).then(
        (r) => r.status,
        (err: { code?: string }) => err.code,
      );
      expect([name, outcome]).toEqual([
        name,
        offered.includes(name) ? 200 : "provider_not_connected",
      ]);
    }
  });
});
