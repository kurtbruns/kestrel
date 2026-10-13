/**
 * A send read as a `SendView` (SPEC §8), for every route that answers with one: the send's
 * route, every action, and every refusal that carries the send as it stands, so a client
 * learns where the send stands without a second read. Beside it, the cursor an answer hands
 * back: where the read stood among the changes to sends, to follow the send from.
 */

import { encodeSendCursor } from "../../shared/cursor";
import { utcDayStart, type WritesDay, writesDay } from "../../shared/daily_writes";
import type { SendView } from "../../shared/sends";
import { importWritesSince } from "../db/imports";
import { currentSendSeq, getSendViewRow } from "../db/sends";
import { type AppEnv, type Config, getConfig, onFreePlanLimits } from "../env";
import { buildSendView } from "./view";

/**
 * On Workers Free's limits, the UTC day so far that a send's `daily_writes` condition weighs
 * (what its imports wrote); null on any other deployment, which reads nothing for it.
 */
export async function readWritesDay(
  db: D1Database,
  config: Pick<Config, "subrequestBudget">,
  now: number,
): Promise<WritesDay | null> {
  return onFreePlanLimits(config)
    ? writesDay(now, await importWritesSince(db, utcDayStart(now)))
    : null;
}

/** The send as it stands, or null when it is gone. */
export async function viewSend(env: AppEnv, id: string): Promise<SendView | null> {
  const now = Date.now();
  const config = getConfig(env);
  const row = await getSendViewRow(env.DB, id);
  if (!row) {
    return null;
  }
  const { has_retries, ...source } = row;
  const day = await readWritesDay(env.DB, config, now);
  return buildSendView(source, config, has_retries === 1, now, day);
}

/** The send as it stands, with the cursor to follow it from, or null when it is gone. The
 *  sequence is read first, so whatever the view shows is at or after the cursor, and
 *  following it misses nothing. */
export async function viewWithCursor(
  env: AppEnv,
  id: string,
): Promise<{ send: SendView; cursor: string } | null> {
  const at = Date.now();
  const seq = await currentSendSeq(env.DB);
  const send = await viewSend(env, id);
  return send ? { send, cursor: encodeSendCursor({ seq, at }) } : null;
}
