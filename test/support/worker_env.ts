/**
 * The Worker under other deploy vars, as a dev server's own `.dev.vars` would set them: for
 * specs whose behavior hangs on a var the suite's config leaves unset (the send simulation,
 * say), called directly or through the Worker's own fetch handler.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AppEnv } from "../../src/env";
import worker from "../../src/index";
import { base } from "./http";

/** This suite's env with some vars overridden. */
export const withVars = (vars: Record<string, string>): AppEnv =>
  ({ ...env, ...vars }) as unknown as AppEnv;

/** A request to the Worker under `vars`, waiting for its background work, so nothing it
 *  left to `waitUntil` lands on the next test. */
export async function fetchWith(
  vars: Record<string, string>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${base}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    withVars(vars),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
