/**
 * Switching what local dev simulates on a running server (SPEC §10): `SIMULATE_SENDS` and
 * `SIMULATE_ACCOUNT` as the developer last named them through `POST /api/dev/simulation`,
 * laid over the env at the Worker's entry, so everything that reads the two through
 * `getConfig` reads the switched values and `getConfig` itself stays a pure function of the
 * env it is handed.
 *
 * The switch is the two variables' own strings and nothing else. It is checked by handing
 * the candidate env to `getConfig`, so a value the app would refuse to start with is refused
 * in the same words, and it writes no row: the app meets the new profile as it would meet a
 * provider that changed, in the provider's next answer or the next account reading.
 *
 * It is module state, so it lasts as long as the dev isolate, like the fake outbox and the
 * simulation's per-send state: a restart, or a reload of the Worker (wrangler reloads it when
 * a source file or the served editor tree changes), returns to the profile the server started
 * with. It is laid over the env only where the env it is given is local dev's (`devMode`),
 * the predicate that also decides whether the route that sets it exists, and `getConfig`
 * reads the two variables only in a dev-shaped env besides, so no deployment can be switched.
 */

import type { DevSimulationResponse } from "../../shared/settings";
import { type AppEnv, getConfig } from "../env";

/** The switch in force: each variable's value, or null for one left as the server started. */
interface Switched {
  sends: string | null;
  account: string | null;
  at: number;
}

let switched: Switched | null = null;

/** Each env the switch was laid over, by the env it made: the route reads the startup values
 *  from it, since the env a handler is given is the one already switched. */
const startups = new WeakMap<AppEnv, AppEnv>();

function laidOver(env: AppEnv, s: Switched): AppEnv {
  return {
    ...env,
    ...(s.sends !== null ? { SIMULATE_SENDS: s.sends } : {}),
    ...(s.account !== null ? { SIMULATE_ACCOUNT: s.account } : {}),
  };
}

/** Whether `env` is local dev's. A config the app refuses is not: its refusal is the entry's
 *  to give, on the env as it was started. */
function isLocalDev(env: AppEnv): boolean {
  try {
    return getConfig(env).devMode;
  } catch {
    return false;
  }
}

const startupOf = (env: AppEnv): AppEnv => startups.get(env) ?? env;

/**
 * The env the Worker runs on: `env` with the switch laid over it in local dev, and `env`
 * itself anywhere else or while nothing is switched. Both of the Worker's handlers call it
 * before anything reads the config.
 */
export function liveEnv(env: AppEnv): AppEnv {
  if (!switched || !isLocalDev(env)) {
    return env;
  }
  const live = laidOver(env, switched);
  startups.set(live, env);
  return live;
}

/**
 * Switch one or both variables. A string is the variable's new value, exactly as the variable
 * takes it; null returns it to what the server started with; undefined leaves it as it is.
 * The two are checked together, as at startup, and a pair the app would refuse to start with
 * throws `getConfig`'s own `ConfigError` and changes nothing.
 */
export function switchSimulation(
  env: AppEnv,
  change: { sends?: string | null; account?: string | null },
  now: number,
): void {
  const next: Switched = {
    sends: change.sends !== undefined ? change.sends : (switched?.sends ?? null),
    account: change.account !== undefined ? change.account : (switched?.account ?? null),
    at: now,
  };
  getConfig(laidOver(startupOf(env), next));
  switched = next.sends === null && next.account === null ? null : next;
}

/** A variable's value as it is shown: unset reads as `off`, which is what it means. */
const shown = (v: string | undefined): string => v?.trim() || "off";

/** What the server simulates now, and whether each variable is as it started or switched. */
export function simulationState(env: AppEnv): DevSimulationResponse {
  const startup = startupOf(env);
  const live = liveEnv(startup);
  const config = getConfig(live);
  const isSwitched = live !== startup && switched !== null;
  return {
    sends: shown(live.SIMULATE_SENDS),
    account: shown(live.SIMULATE_ACCOUNT),
    source: {
      sends: isSwitched && switched?.sends !== null ? "switch" : "startup",
      account: isSwitched && switched?.account !== null ? "switch" : "startup",
    },
    startup: { sends: shown(startup.SIMULATE_SENDS), account: shown(startup.SIMULATE_ACCOUNT) },
    switched_at: isSwitched && switched ? new Date(switched.at).toISOString() : null,
    simulation: config.simulation,
    not_connected: config.notConnectedPreview,
  };
}

/** Forget the switch, as a restarted dev server would. For tests. */
export function resetSimulationSwitch(): void {
  switched = null;
}
