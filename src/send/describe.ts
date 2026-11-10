/**
 * A send read as a `SendView` (SPEC §8), for every route that answers with one: the send's
 * route, every action, every refusal that carries the send as it stands, and the scheduled
 * sends a settings save would re-make, so a client learns where the send stands without a
 * second read. A post refers to its send instead (`postSendRefs`). Beside it, the cursor an answer hands
 * back: where the read stood among the changes to sends, to follow the send from. And the
 * deployment's part of every send's conditions (`readConditionContext`), read once per answer.
 */

import { encodeSendCursor } from "../../shared/cursor";
import type { SendView } from "../../shared/sends";
import {
  type ProviderAccountRaw,
  parseProviderAccount,
  providerAccountStatement,
} from "../db/provider_account";
import { parseSending, type SendingRaw, sendingStatement } from "../db/sending";
import { currentSendSeq, getSendViewRow, getSendViewRows } from "../db/sends";
import { storedTimeZone, timeZoneStatement } from "../db/settings";
import { type AppEnv, type Config, getConfig, onFreePlanLimits } from "../env";
import { sandboxOf } from "../services/provider_status";
import { sendingView } from "../services/sending";
import type { SendViewContext } from "./conditions";
import { buildSendView } from "./view";

/**
 * What the deployment adds to a send's view (`SendViewContext`): whether the publication has a
 * time zone, which a reschedule needs (SPEC §9), and for its conditions the plan's limits
 * from config, and the provider's account and whether email is getting out (SPEC §13) from the
 * database, both rows in one round trip, since every feed poll and every action's answer
 * reads them. Every send in an answer is read against the same context, so the list, the
 * feed, and the send never disagree on the deployment's state. What each row means for the
 * deployment is decided where it always is (`sandboxOf`, `sendingView`), a deployment with no
 * provider included.
 */
export async function readConditionContext(
  db: D1Database,
  config: Config,
): Promise<SendViewContext> {
  const [account, sending, settings] = await db.batch<Record<string, unknown>>([
    providerAccountStatement(db),
    sendingStatement(db),
    timeZoneStatement(db),
  ]);
  return {
    timeZoneSet:
      storedTimeZone(settings?.results[0] as { time_zone: unknown } | undefined) !== null,
    freePlan: onFreePlanLimits(config),
    sandbox: sandboxOf(
      config,
      parseProviderAccount(account?.results[0] as ProviderAccountRaw | undefined),
    ),
    sending: sendingView(config, parseSending(sending?.results[0] as SendingRaw | undefined)),
  };
}

/** The send as it stands, or null when it is gone. */
export async function viewSend(env: AppEnv, id: string): Promise<SendView | null> {
  const now = Date.now();
  const config = getConfig(env);
  const [row, context] = await Promise.all([
    getSendViewRow(env.DB, id),
    readConditionContext(env.DB, config),
  ]);
  if (!row) {
    return null;
  }
  const { has_retries, ...source } = row;
  return buildSendView(source, config, has_retries === 1, now, context);
}

/** Sends by id as they stand, each as its view, by id; a send that is gone is left out. One
 *  read and one moment for them all. */
export async function viewSends(env: AppEnv, ids: string[]): Promise<Map<string, SendView>> {
  const now = Date.now();
  const config = getConfig(env);
  const [rows, context] = await Promise.all([
    getSendViewRows(env.DB, ids),
    readConditionContext(env.DB, config),
  ]);
  return new Map(
    rows.map(({ has_retries, ...source }) => [
      source.id,
      buildSendView(source, config, has_retries === 1, now, context),
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
