/**
 * The sweep's last step: tell the publisher about what happened to their sends (SPEC §8).
 *
 * Each tick records every new event once (`recordNotifications`), then delivers the
 * pending ones through the channel, as many as its share of the invocation's subrequest
 * budget allows (`budget.ts`); what does not fit waits for the next tick. Every statement
 * is metered and every delivery charged, so notifying never pushes a tick past its cap.
 *
 * It runs after the sends, reads the send record, and writes only its own table, so a
 * notification that fails, or this whole step throwing, never changes a send (I1 to I6).
 * A failure is logged as NOTIFY_FAILED and kept on the row, where the settings surface
 * shows it.
 */

import * as notifications from "../db/notifications";
import { getSettings } from "../db/settings";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { MAX_NOTIFY_ATTEMPTS } from "../lib/time";
import { type Budget, metered } from "../send/budget";
import { getNotifier } from "./channel";
import { composeNotification } from "./compose";

/** Record the events, list the due, read the destination, and claim them: four statements. */
const OPEN_COST = 4;
/** One delivery: the channel's request and recording how it went. */
const EACH_COST = 2;
/** What a tick holds back so it can always deliver at least one notification. */
export const NOTIFY_RESERVE = OPEN_COST + EACH_COST;
/** The most a tick delivers, however much budget is left, so a backlog drains steadily. */
const MAX_PER_TICK = 10;

export async function notifyPublisher(env: AppEnv, budget: Budget): Promise<void> {
  const config = getConfig(env);
  const db = metered(env.DB, budget);
  const now = Date.now();

  await notifications.recordNotifications(db, now);
  const room = Math.min(MAX_PER_TICK, Math.floor((budget.left - (OPEN_COST - 1)) / EACH_COST));
  if (room < 1) {
    return;
  }
  const due = await notifications.dueNotifications(db, room);
  if (due.length === 0) {
    return;
  }
  const { to } = (await getSettings(db)).notifications;
  if (!to) {
    await notifications.closeUnaddressed(db, now);
    return;
  }
  await notifications.claimNotifications(db, due, now);

  const notifier = getNotifier(config, env);
  for (const n of due) {
    const key = `${n.send_id}-${n.kind}-${n.episode}`;
    budget.spend(); // the channel's request, which counts whether or not it succeeds
    try {
      await notifier.send(to, composeNotification(n, config), key);
      await notifications.recordNotificationOutcome(db, n, { sent: true }, Date.now());
    } catch (err) {
      const error = String((err as Error)?.message ?? err);
      const giveUp = n.attempts + 1 >= MAX_NOTIFY_ATTEMPTS;
      console.error("NOTIFY_FAILED", {
        sendId: n.send_id,
        kind: n.kind,
        channel: notifier.channel,
        error,
        giveUp,
      });
      await notifications.recordNotificationOutcome(
        db,
        n,
        { sent: false, error, giveUp },
        Date.now(),
      );
    }
  }
}
