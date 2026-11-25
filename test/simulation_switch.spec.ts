import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sends from "../src/db/sends";
import { RECEIPTS_CRON } from "../src/dev/simulated_receipts";
import { liveEnv, resetSimulationSwitch } from "../src/dev/simulation_switch";
import { ConfigError, getConfig } from "../src/env";
import worker from "../src/index";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { toNextTick } from "./support/clock";
import { SES_DEPLOY } from "./support/deploy";
import {
  addresses,
  deliveryEvent,
  dueSend,
  resetDatabase,
  seedConfirmed,
  seedDelivery,
} from "./support/fixtures";
import { AUTH, JSON_AUTH, readJson } from "./support/http";
import { logged } from "./support/log";
import { resetSimulation } from "./support/simulation";
import { fetchWith, withVars } from "./support/worker_env";

// Switching what local dev simulates on a running server (SPEC §10): the two variables,
// changed through the dev route and read by everything that reads the config, checked as at
// startup, and held where no deployment can reach them. Each test's server "started" with
// the vars it names, and the switch is module state, so it is cleared before each.

const HOUR = 60 * 60 * 1000;

/** A dev server started simulating SES with no injected failures. */
const STARTED = { SIMULATE_SENDS: "ses:none" };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await resetDatabase();
  clearFakeOutbox();
  resetSimulation();
  resetSimulationSwitch();
});

afterEach(() => {
  resetSimulationSwitch();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const read = (vars: Record<string, string> = STARTED) =>
  fetchWith(vars, "/api/dev/simulation", { headers: AUTH });

const post = (body: unknown, vars: Record<string, string> = STARTED) =>
  fetchWith(vars, "/api/dev/simulation", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(body),
  });

/** Run the Worker's scheduled handler once with `cron` as its trigger, on a server started
 *  with `vars`. */
async function scheduled(cron: string, vars: Record<string, string> = STARTED): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron, scheduledTime: Date.now() }),
    withVars(vars),
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

const SWEEP_CRON = "* * * * *";

describe("GET /api/dev/simulation", () => {
  it("answers the two variables as the server started, with nothing switched", async () => {
    const res = await read({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: "sandbox" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sends: "ses",
      account: "sandbox",
      source: { sends: "startup", account: "startup" },
      startup: { sends: "ses", account: "sandbox" },
      switched_at: null,
      simulation: getConfig(withVars({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: "sandbox" }))
        .simulation,
      not_connected: false,
    });
  });

  it("reads a variable left unset as off", async () => {
    expect(await readJson(await read({}))).toMatchObject({
      sends: "off",
      account: "off",
      simulation: null,
    });
  });
});

describe("POST /api/dev/simulation", () => {
  it("switches the send profile for every later request, and says when", async () => {
    const at = Date.now();
    const switched = await post({ sends: "ses:outage" });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      sends: "ses:outage",
      account: "off",
      source: { sends: "switch", account: "startup" },
      startup: { sends: "ses:none", account: "off" },
      switched_at: new Date(at).toISOString(),
      simulation: { profile: "ses", faults: "realistic", answer: { kind: "outage" } },
    });
    // Settings, which the editor and the dev tools read, is on the switched profile too.
    const settings = await readJson(await fetchWith(STARTED, "/api/settings", { headers: AUTH }));
    expect(settings.deployment.simulation.answer).toEqual({ kind: "outage" });
    expect(await readJson(await read())).toMatchObject({ sends: "ses:outage" });
  });

  it("leaves a variable it doesn't name as it is, and null returns one to the server's own", async () => {
    await post({ sends: "ses", account: "sandbox:unrouted" });
    expect(await readJson(await post({ sends: "ses:rejected" }))).toMatchObject({
      sends: "ses:rejected",
      account: "sandbox:unrouted",
      source: { sends: "switch", account: "switch" },
    });
    expect(await readJson(await post({ account: null }))).toMatchObject({
      sends: "ses:rejected",
      account: "off",
      source: { sends: "switch", account: "startup" },
    });
    expect(await readJson(await post({ sends: null }))).toEqual(await readJson(await read()));
    expect(await readJson(await read())).toMatchObject({
      sends: "ses:none",
      source: { sends: "startup", account: "startup" },
      switched_at: null,
    });
  });

  it("switches to not connected and back, the provider with it (SPEC §13)", async () => {
    expect(await readJson(await post({ sends: "not-connected" }))).toMatchObject({
      not_connected: true,
      simulation: null,
    });
    const gone = await readJson(await fetchWith(STARTED, "/api/settings", { headers: AUTH }));
    expect(gone.deployment).toMatchObject({ provider: "none", not_connected_preview: true });
    await post({ sends: null });
    const back = await readJson(await fetchWith(STARTED, "/api/settings", { headers: AUTH }));
    expect(back.deployment).toMatchObject({ provider: "fake", not_connected_preview: false });
  });

  // The same parser as startup, so the same words: each refusal is `getConfig`'s own for the
  // pair the switch would have made.
  it.each([
    ["sends", { sends: "sez" }, { SIMULATE_SENDS: "sez" }],
    ["sends", { sends: "1:outage" }, { SIMULATE_SENDS: "1:outage" }],
    ["sends", { sends: "ses:refuse=nope" }, { SIMULATE_SENDS: "ses:refuse=nope" }],
    ["account", { account: "sandbx" }, { SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "sandbx" }],
    [
      "account",
      { account: "sandbox:unreported:wrong_topic" },
      { SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "sandbox:unreported:wrong_topic" },
    ],
    [
      "account",
      { sends: "generic", account: "sandbox" },
      { SIMULATE_SENDS: "generic", SIMULATE_ACCOUNT: "sandbox" },
    ],
  ] as const)(
    "refuses a value startup would, in startup's words: %s %j",
    async (field, body, vars) => {
      let startup: unknown;
      try {
        getConfig(withVars(vars));
      } catch (err) {
        startup = err;
      }
      expect(startup).toBeInstanceOf(ConfigError);
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        message: (startup as ConfigError).message,
        field,
      });
      // Nothing changed: the server is still on what it started with.
      expect(await readJson(await read())).toMatchObject({ sends: "ses:none", switched_at: null });
    },
  );

  it("refuses a send profile the switched account can't stand beside, and keeps both", async () => {
    await post({ sends: "ses", account: "sandbox" });
    const res = await post({ sends: "generic" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      field: "account",
      message:
        'SIMULATE_ACCOUNT stands in for the SES account, so it needs SIMULATE_SENDS=ses, not "generic"',
    });
    expect(await readJson(await read())).toMatchObject({ sends: "ses", account: "sandbox" });
  });

  it("refuses a body that names neither, and a key it doesn't take", async () => {
    expect((await post({})).status).toBe(400);
    const res = await post({ profile: "ses" });
    expect(res.status).toBe(400);
    expect(await readJson(await read())).toMatchObject({ switched_at: null });
  });

  it("logs each switch with the two values as they now read", async () => {
    const spy = vi.spyOn(console, "log");
    await post({ sends: "ses:outage" });
    expect(logged(spy).filter((l) => l.event === "dev.simulation_switched")).toMatchObject([
      { sends: "ses:outage", account: "off" },
    ]);
  });
});

describe("a switch, off this machine", () => {
  // The switch is held in the isolate, so these make one on a dev env first and then ask
  // what an env that isn't local dev's runs on.
  it("is laid over local dev's env and no other (SPEC §9)", async () => {
    await post({ sends: "not-connected" });
    const dev = withVars(STARTED);
    expect(getConfig(liveEnv(dev)).provider).toBe("none");
    const demo = withVars({
      PROVIDER: "fake",
      ALLOW_FAKE_PROVIDER: "true",
      APP_ORIGIN: "https://newsletter.birds.example",
      SIMULATE_SENDS: "",
    });
    for (const e of [withVars(SES_DEPLOY), demo, withVars({ DEV_AUTH_SECRET: "" })]) {
      expect(liveEnv(e)).toBe(e);
    }
    expect(getConfig(liveEnv(withVars(SES_DEPLOY))).provider).toBe("ses");
  });

  it("leaves a config the app refuses to its own refusal", async () => {
    await post({ sends: "ses:outage" });
    const refused = withVars({ SIMULATE_SENDS: "sez" });
    expect(liveEnv(refused)).toBe(refused);
  });
});

describe("a switch, on the sweep and the receipts tick", () => {
  const halt = async (id: string) => {
    const row = await sends.getSend(env.DB, id);
    return row ? [row.status, row.halt_cause, row.c_pending, row.c_accepted] : null;
  };

  it("holds a send the sweep fires after a switch to an outage (SPEC §10, §12)", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    await post({ sends: "ses:outage" });
    await scheduled(SWEEP_CRON);
    expect(await halt(send.id)).toEqual(["sending", "outage", 3, 0]);
    expect(fakeOutbox()).toHaveLength(0);
  });

  it("resumes a held send at its own retry once the profile is switched back, mailing each reader once (SPEC §12, I4)", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    await post({ sends: "ses:outage" });
    await scheduled(SWEEP_CRON);
    expect(await halt(send.id)).toEqual(["sending", "outage", 3, 0]);

    await post({ sends: null });
    // The switch wrote nothing: the send is still held, and a tick before its retry leaves it.
    expect(await halt(send.id)).toEqual(["sending", "outage", 3, 0]);
    await scheduled(SWEEP_CRON);
    expect(await halt(send.id)).toEqual(["sending", "outage", 3, 0]);

    await toNextTick(env.DB);
    await scheduled(SWEEP_CRON);
    expect(await halt(send.id)).toEqual(["sent", null, 0, 3]);
    expect(
      fakeOutbox()
        .map((m) => m.to)
        .sort(),
    ).toEqual([...addresses(3)].sort());
  });

  it("settles receipts by the switched profile on the receipts tick", async () => {
    await seedDelivery("r@example.com", "sim-1");
    vi.setSystemTime(Date.now() + 2 * HOUR); // long past every receipt's lag
    // Switched to the plain fake, nothing reports back.
    await post({ sends: "off" });
    await scheduled(RECEIPTS_CRON);
    expect(await deliveryEvent("sim-1")).toBeNull();
    // Back on the simulation the server started with, the report arrives.
    await post({ sends: null });
    await scheduled(RECEIPTS_CRON);
    expect(await deliveryEvent("sim-1")).toBe("delivered");
  });
});
