// A deployment with no email provider connected (SPEC §9): `PROVIDER` unset or `none`. The
// app runs, and refuses everything that would send with one named refusal; the public
// subscribe page says signups aren't open; a send scheduled before is held, consuming no
// one. The fake runs only where it is named.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import { type AppEnv, getConfig } from "../src/env";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import type { RequestContext } from "../src/router";
import * as renderRoutes from "../src/routes/render_actions";
import * as scheduleRoutes from "../src/routes/schedule";
import * as settingsRoutes from "../src/routes/settings";
import * as subscriberRoutes from "../src/routes/subscribers";
import { dueSend, resetDatabase, seedConfirmed, tick } from "./support/fixtures";
import { base, readJson } from "./support/http";
import { logged } from "./support/log";
import { fetchWith, withVars } from "./support/worker_env";

/** The suite's env with no provider named, as the production template ships. */
const NOT_CONNECTED = { PROVIDER: "", APP_ORIGIN: "https://newsletter.birds.example" };

/**
 * A handler's context under `vars`. Called directly rather than through the router: off the
 * fake, the env is no longer dev-shaped, so the suite's dev token no longer authenticates.
 */
function context(
  vars: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): RequestContext {
  const e = withVars(vars);
  const req = new Request(`${base}${path}`, {
    method: init.method ?? "POST",
    ...(init.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  return {
    req,
    env: e,
    ctx: createExecutionContext(),
    url: new URL(req.url),
    params: init.params ?? {},
    config: getConfig(e),
  } as unknown as RequestContext;
}

async function subscriberCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{ n: number }>();
  return row?.n ?? 0;
}

async function sendCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sends").first<{ n: number }>();
  return row?.n ?? 0;
}

const REFUSED = { status: 409, code: "provider_not_connected" };

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("which provider a deployment runs on (SPEC §9)", () => {
  it("reads an unset, blank, or `none` PROVIDER as not connected, on any origin", () => {
    for (const vars of [
      { PROVIDER: "", APP_ORIGIN: "https://newsletter.birds.example" },
      { PROVIDER: "none", APP_ORIGIN: "https://newsletter.birds.example" },
      { PROVIDER: "", APP_ORIGIN: "http://localhost:8787" },
    ]) {
      expect(getConfig(withVars(vars)).provider, JSON.stringify(vars)).toBe("none");
    }
  });

  it("runs the fake only where it is named, a deployed demo included", () => {
    expect(getConfig(withVars({ PROVIDER: "fake" })).provider).toBe("fake");
    expect(
      getConfig(withVars({ PROVIDER: "fake", APP_ORIGIN: "https://demo.birds.example" })).provider,
    ).toBe("fake");
  });

  it("is never local development, so the dev routes and the dev token are off", () => {
    const config = getConfig(withVars({ PROVIDER: "", APP_ORIGIN: "http://localhost:8787" }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
    expect(config.simulation).toBeNull();
  });

  it("reflects the state in Settings' deployment block", async () => {
    const res = await settingsRoutes.get(
      context(NOT_CONNECTED, "/api/settings", { method: "GET" }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).deployment.provider).toBe("none");
  });
});

describe("everything that would send is refused with provider_not_connected", () => {
  async function draft() {
    const { post } = await posts.createPost(env.DB, { subject: "Hello", markdown: "Hi" }, "test");
    return post;
  }

  it("refuses scheduling, and freezes nothing", async () => {
    const post = await draft();
    const c = context(NOT_CONNECTED, `/api/posts/${post.id}/schedule`, {
      body: { fire_at: Date.now() + 86_400_000 },
      params: { id: post.id },
    });
    await expect(scheduleRoutes.schedule(c)).rejects.toMatchObject(REFUSED);
    expect(await sendCount()).toBe(0);
  });

  it("refuses send now, and freezes nothing", async () => {
    const post = await draft();
    const c = context(NOT_CONNECTED, `/api/posts/${post.id}/send`, { params: { id: post.id } });
    await expect(scheduleRoutes.sendNow(c)).rejects.toMatchObject(REFUSED);
    expect(await sendCount()).toBe(0);
  });

  it("refuses a post's test email", async () => {
    const post = await draft();
    const c = context(NOT_CONNECTED, `/api/posts/${post.id}/test`, {
      body: { to: "me@birds.example" },
      params: { id: post.id },
    });
    await expect(renderRoutes.test(c)).rejects.toMatchObject(REFUSED);
  });

  it("refuses the template's test email", async () => {
    const c = context(NOT_CONNECTED, "/api/settings/template/test", {
      body: { to: "me@birds.example" },
    });
    await expect(renderRoutes.templateTest(c)).rejects.toMatchObject(REFUSED);
  });

  it("refuses a test notification through the provider, and records no failure", async () => {
    await updateSettings(env.DB, { notifications: { to: "me@birds.example" } });
    const c = context(NOT_CONNECTED, "/api/settings/notifications/test");
    expect(c.config.notifyChannel).toBe("provider");
    await expect(settingsRoutes.notificationTest(c)).rejects.toMatchObject(REFUSED);
    const status = await readJson(
      await settingsRoutes.get(context(NOT_CONNECTED, "/api/settings", { method: "GET" })),
    );
    expect(status.notificationStatus.lastFailure).toBeNull();
  });

  it("refuses adding a subscriber by hand, since their confirmation can't go, and stores nothing", async () => {
    const c = context(NOT_CONNECTED, "/api/subscribers", {
      body: { email: "reader@birds.example" },
    });
    await expect(subscriberRoutes.create(c)).rejects.toMatchObject(REFUSED);
    expect(await subscriberCount()).toBe(0);
  });

  it("refuses nothing on the fake, where it is named", async () => {
    const post = await draft();
    const res = await renderRoutes.test(
      context({ PROVIDER: "fake" }, `/api/posts/${post.id}/test`, {
        body: { to: "me@birds.example" },
        params: { id: post.id },
      }),
    );
    expect((await readJson(res)).sent).toBe(true);
    expect(fakeOutbox()).toHaveLength(1);
  });
});

describe("the public subscribe page while signups aren't open (SPEC §7, §9)", () => {
  it("says signups aren't open yet, with no form to take an address", async () => {
    const res = await fetchWith(NOT_CONNECTED, "/subscribe");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Signups aren’t open yet");
    expect(page).not.toContain("<form");
  });

  it("refuses a form post the same way for every address, storing nothing, and logs it", async () => {
    const warn = vi.spyOn(console, "warn");
    await seedConfirmed("known@birds.example");
    const pages: string[] = [];
    for (const email of ["known@birds.example", "new@birds.example"]) {
      const res = await fetchWith(NOT_CONNECTED, "/subscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
      });
      expect(res.status).toBe(409);
      pages.push(await res.text());
    }
    expect(pages[0]).toContain("Signups aren’t open yet");
    expect(pages[1]).toBe(pages[0]);
    expect(await subscriberCount()).toBe(1);
    expect(fakeOutbox()).toHaveLength(0);
    expect(logged(warn).filter((l) => l.event === "subscribe.not_connected")).toHaveLength(2);
  });

  it("refuses a JSON request with provider_not_connected", async () => {
    const res = await fetchWith(NOT_CONNECTED, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@birds.example" }),
    });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("provider_not_connected");
    expect(await subscriberCount()).toBe(0);
  });

  it("keeps the form when a provider is named", async () => {
    const page = await (await fetchWith({ PROVIDER: "fake" }, "/subscribe")).text();
    expect(page).toContain('action="/subscribe"');
  });
});

describe("a send scheduled before the provider was disconnected", () => {
  it("is held like a provider refusing the account: nobody consumed, nothing delivered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedConfirmed(["a@birds.example", "b@birds.example"]);
    const send = await dueSend();
    const e: AppEnv = withVars(NOT_CONNECTED);
    await tick(e);
    const held = (await sends.getSend(env.DB, send.id))!;
    expect(held.status).toBe("sending");
    expect(held.halt_reason).toBe("account");
    expect(held.halt_error).toMatch(/No email provider is connected/);
    expect(held.c_accepted).toBe(0);
    expect(held.c_unsent).toBe(0);
    expect(fakeOutbox()).toHaveLength(0);
  });
});

describe("the provider webhooks while not connected", () => {
  it("answer 404, since no provider is there to call them", async () => {
    for (const path of ["/webhooks/resend", "/webhooks/ses"]) {
      const res = await fetchWith(NOT_CONNECTED, path, { method: "POST", body: "{}" });
      expect(res.status, path).toBe(404);
    }
  });
});
