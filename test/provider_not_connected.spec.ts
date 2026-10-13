// A deployment with no email provider connected (SPEC §9): `PROVIDER` unset or `none`. The
// app runs, and refuses everything that would send with one named refusal; the public
// subscribe page says signups aren't open; a send scheduled before is held, consuming no
// one. The fake runs only where it is named. Local dev previews the same state through
// `SIMULATE_SENDS=not-connected`, on the same code.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/app";
import type { DueNotification } from "../src/db/notifications";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import { type AppEnv, getConfig } from "../src/env";
import { HALT_BACKOFF_MS, HALT_RETRY_SLACK_MS } from "../src/lib/time";
import { composeNotification } from "../src/notify/compose";
import { clearFakeNotifications, fakeNotifications } from "../src/notify/fake";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import type { RequestContext } from "../src/router";
import * as renderRoutes from "../src/routes/render_actions";
import * as scheduleRoutes from "../src/routes/schedule";
import * as settingsRoutes from "../src/routes/settings";
import * as subscriberRoutes from "../src/routes/subscribers";
import { condition } from "./support/conditions";
import { NOT_CONNECTED_DEPLOY, SES_DEPLOY } from "./support/deploy";
import { dueSend, resetDatabase, seedConfirmed, tick } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { logged } from "./support/log";
import { viewOf } from "./support/view";
import { fetchWith, withVars } from "./support/worker_env";

/** The suite's env with no provider named, as the production template ships. */
const NOT_CONNECTED = { ...NOT_CONNECTED_DEPLOY, APP_ORIGIN: "https://newsletter.birds.example" };

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
    // What the gate sets on every admin request; a deployed one signs in through Access.
    principal: { kind: "human", email: "tester@example.com", via: "access" },
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

/** What the `not_connected` cause advises, said once wherever the held send is described. */
const ADVICE = "Connect an email provider (the setup guide walks through it), then deploy.";

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  clearFakeNotifications();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("which provider a deployment runs on (SPEC §9)", () => {
  it("reads an unset, blank, or `none` PROVIDER as not connected, on any origin", () => {
    for (const vars of [
      NOT_CONNECTED,
      { ...NOT_CONNECTED, PROVIDER: "none" },
      { ...NOT_CONNECTED, APP_ORIGIN: "http://localhost:8787" },
    ]) {
      expect(getConfig(withVars(vars)).provider, JSON.stringify(vars)).toBe("none");
    }
  });

  it("runs the fake only where it is named, a deployed demo included", () => {
    expect(getConfig(withVars({ PROVIDER: "fake" })).provider).toBe("fake");
    expect(
      getConfig(
        withVars({
          PROVIDER: "fake",
          ALLOW_FAKE_PROVIDER: "true",
          APP_ORIGIN: "https://demo.birds.example",
        }),
      ).provider,
    ).toBe("fake");
  });

  it("is never local development, so the dev routes and the dev token are off", () => {
    const config = getConfig(withVars({ ...NOT_CONNECTED, APP_ORIGIN: "http://localhost:8787" }));
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

  it("refuses even an address that isn't one, since the address is never read", async () => {
    const res = await fetchWith(NOT_CONNECTED, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "not an address" }).toString(),
    });
    expect(res.status).toBe(409); // a read address would be a 400 first
    expect(await res.text()).toContain("Signups aren’t open yet");
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
    // Its refusal names the missing provider and how to connect one, not a credential to
    // replace (SPEC §12).
    expect(held.halt_cause).toBe("not_connected");
    const refused = condition(viewOf(held, "none", false, Date.now()), "refused");
    expect(refused).toMatchObject({
      cause: "not_connected",
      advice: ADVICE,
      error: "No email provider is connected to this deployment.",
    });
    // Said as what it is, the fix once: no provider is refusing anything.
    expect(refused?.message).toBe(
      `No email provider is connected, so this send is held where it is. ${ADVICE} No one has been marked unsent, and the send goes out at its first retry after a provider is connected.`,
    );
  });

  it("goes out to everyone, once, at the first retry after a provider is connected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const audience = ["a@birds.example", "b@birds.example", "c@birds.example"];
    await seedConfirmed(audience);
    const send = await dueSend();
    const unconnected = withVars(NOT_CONNECTED);
    await tick(unconnected);
    // `tick` moves the clock on to the held send's next retry, as the cron reaches it.
    const firstHalt = (await sends.getSend(env.DB, send.id))!.halted_at!;
    await tick(unconnected); // its first retry, still not connected: held, nobody consumed
    expect(Date.now() - firstHalt).toBeGreaterThanOrEqual(
      HALT_BACKOFF_MS.account[0]! - HALT_RETRY_SLACK_MS,
    );
    expect((await sends.getSend(env.DB, send.id))!.c_accepted).toBe(0);
    // Connected: the next retry sends it.
    await tick(withVars({ PROVIDER: "fake" }));
    const done = (await sends.getSend(env.DB, send.id))!;
    expect(done.status).toBe("sent");
    expect(done.c_accepted).toBe(audience.length);
    expect(done.halt_reason).toBeNull();
    expect(
      fakeOutbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual(audience);
  });

  it("tells the publisher no provider is connected, not that one is refusing the account", () => {
    const email = composeNotification(
      {
        send_id: "s1",
        kind: "refused",
        episode: 0,
        attempts: 0,
        subject: "Owls",
        send_status: "sending",
        fire_at: 0,
        started_at: 0,
        completed_at: null,
        locked_until: null,
        halt_reason: "account",
        halted_at: 0,
        halt_cause: "not_connected",
        halt_error: "No email provider is connected to this deployment.",
        c_pending: 3,
        c_in_flight: 0,
        c_accepted: 0,
        c_delivered: 0,
        c_bounced: 0,
        c_complained: 0,
        c_skipped: 0,
        c_unsent: 0,
      } satisfies DueNotification,
      getConfig(env),
    );
    expect(email.subject).toBe('Problem with "Owls": no email provider is connected');
    expect(email.text).not.toMatch(/refusing/);
    expect(email.text.split(ADVICE)).toHaveLength(2); // the fix, said once
  });
});

describe("the dev routes while not connected", () => {
  it("are not registered, even on a localhost origin with the dev secret set", async () => {
    const vars = {
      ...NOT_CONNECTED,
      APP_ORIGIN: "http://localhost:8787",
      DEV_AUTH_SECRET: "test-dev-secret",
    };
    const res = await fetchWith(vars, "/api/dev/token");
    expect(res.status).toBe(404);
    const routes = createRouter(getConfig(withVars(vars))).routes.map((r) => r.def.path);
    expect(routes).not.toContain("/api/dev/token");
  });
});

describe("the provider webhooks while not connected", () => {
  it("answer 404, since no provider is there to call them", async () => {
    const res = await fetchWith(NOT_CONNECTED, "/webhooks/ses", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("local dev's not-connected preview, SIMULATE_SENDS=not-connected (SPEC §10)", () => {
  const PREVIEW = { SIMULATE_SENDS: "not-connected" };

  it("runs as not connected while local sign-in and the dev routes stay on", () => {
    const config = getConfig(withVars(PREVIEW));
    expect(config.provider).toBe("none");
    expect(config.devMode).toBe(true);
    expect(config.simulation).toBeNull();
    expect(config.notConnectedPreview).toBe(true);
    // A deployment with no provider and no NOTIFY binding notifies through the provider.
    expect(config.notifyChannel).toBe("provider");
  });

  it("is never honored outside local dev, and takes no fault suffix", () => {
    const deployed = getConfig(withVars({ ...SES_DEPLOY, ...PREVIEW }));
    expect(deployed.provider).toBe("ses");
    expect(deployed.notConnectedPreview).toBe(false);
    // A real deployment with no provider is not connected, but never the preview.
    expect(getConfig(withVars(NOT_CONNECTED)).notConnectedPreview).toBe(false);
    expect(
      getConfig(
        withVars({
          ...PREVIEW,
          ALLOW_FAKE_PROVIDER: "true",
          APP_ORIGIN: "https://demo.birds.example",
        }),
      ).provider,
    ).toBe("fake");
    expect(() => getConfig(withVars({ SIMULATE_SENDS: "not-connected:none" }))).toThrow(
      expect.objectContaining({ name: "ConfigError", variable: "SIMULATE_SENDS" }),
    );
  });

  it("reflects not connected, refuses what would send, and closes signups, through the real routes", async () => {
    const settings = await readJson(await fetchWith(PREVIEW, "/api/settings", { headers: AUTH }));
    expect(settings.deployment.provider).toBe("none");
    expect(settings.deployment.notConnectedPreview).toBe(true);
    expect(settings.deployment.notifyChannel).toBe("provider");

    const { post } = await posts.createPost(env.DB, { subject: "Hi", markdown: "Hi" }, "test");
    const scheduled = await fetchWith(PREVIEW, `/api/posts/${post.id}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: Date.now() + 86_400_000 }),
    });
    expect(scheduled.status).toBe(409);
    expect((await readJson(scheduled)).error).toBe("provider_not_connected");
    expect(await sendCount()).toBe(0);

    await updateSettings(env.DB, { notifications: { to: "me@birds.example" } });
    const notified = await fetchWith(PREVIEW, "/api/settings/notifications/test", {
      method: "POST",
      headers: AUTH,
    });
    expect(notified.status).toBe(409);
    expect(fakeNotifications()).toHaveLength(0);

    const page = await (await fetchWith(PREVIEW, "/subscribe")).text();
    expect(page).toContain("Signups aren’t open yet");
  });

  it("holds a due send, and it goes out once the preview is turned off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedConfirmed(["a@birds.example", "b@birds.example"]);
    const send = await dueSend();
    await tick(withVars(PREVIEW));
    const held = (await sends.getSend(env.DB, send.id))!;
    expect(held.halt_cause).toBe("not_connected");
    expect(held.c_accepted).toBe(0);
    expect(fakeOutbox()).toHaveLength(0);
    await tick(withVars({ SIMULATE_SENDS: "off" }));
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(fakeOutbox()).toHaveLength(2);
  });
});
