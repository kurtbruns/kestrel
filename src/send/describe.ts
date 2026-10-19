/**
 * A send read as a `SendView` (SPEC §8), for every route that answers with one: the send's
 * route, every action, every refusal that carries the send as it stands, and the scheduled
 * sends a settings save would re-make, so a client learns where the send stands without a
 * second read. A post refers to its send instead (`postSendRefs`). Beside it, the cursor an answer hands
 * back: where the read stood among the changes to sends, to follow the send from.
 */

import { encodeSendCursor } from "../../shared/cursor";
import type { SendView } from "../../shared/sends";
import { currentSendSeq, getSendViewRow, getSendViewRows } from "../db/sends";
import { type AppEnv, getConfig } from "../env";
import { buildSendView } from "./view";

/** The send as it stands, or null when it is gone. */
export async function viewSend(env: AppEnv, id: string): Promise<SendView | null> {
  const now = Date.now();
  const config = getConfig(env);
  const row = await getSendViewRow(env.DB, id);
  if (!row) {
    return null;
  }
  const { has_retries, ...source } = row;
  return buildSendView(source, config, has_retries === 1, now);
}

/** Sends by id as they stand, each as its view, by id; a send that is gone is left out. One
 *  read and one moment for them all. */
export async function viewSends(env: AppEnv, ids: string[]): Promise<Map<string, SendView>> {
  const now = Date.now();
  const config = getConfig(env);
  const rows = await getSendViewRows(env.DB, ids);
  return new Map(
    rows.map(({ has_retries, ...source }) => [
      source.id,
      buildSendView(source, config, has_retries === 1, now),
    ]),
  );
}

/** Sends by id as they stand, each as its view, in the order given; one that is gone is left out. */
export async function viewSendsInOrder(env: AppEnv, ids: string[]): Promise<SendView[]> {
  const views = await viewSends(env, ids);
  return ids.flatMap((id) => views.get(id) ?? []);
}

/** What a refusal about a send carries (docs/API.md, principle 5): the send as it stands, null
 *  when it is gone, and the cursor to follow it from, as every answer about a send has. */
export async function sendAsItStands(
  env: AppEnv,
  id: string,
): Promise<{ send: SendView | null; cursor: string }> {
  const at = Date.now();
  const seq = await currentSendSeq(env.DB);
  return { send: await viewSend(env, id), cursor: encodeSendCursor({ seq, at }) };
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
