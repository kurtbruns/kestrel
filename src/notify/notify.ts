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
 * Each delivery is logged (`notify.sent` or `notify.failed`), and a failure is also kept on
 * the row, where the settings surface shows it. A problem that has cleared by the time its
 * notification is tried (after a channel failure delayed it) is closed as cleared rather
 * than sent, since the email is written from the send as it stands and would describe
 * something no longer true.
 */

import * as notifications from "../db/notifications";
import { getSettings } from "../db/settings";
import type { AppEnv } from "../env";
import { getConfig } from "../env";
import { errorText, log } from "../lib/log";
import { MAX_NOTIFY_ATTEMPTS, MISSED_THRESHOLD_MS } from "../lib/time";
import { type Budget, metered } from "../send/budget";
import { isWedged } from "../send/wedged";
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

/**
 * Whether the event a notification tells of is still true of the send now. A finished
 * send stays finished, and a send that went out late stays late; the other problems can
 * clear (the refusal lifts, the send completes, Resolve settles the wedge, a reschedule
 * moves the fire time), and the tests here mirror the conditions `recordNotifications`
 * recorded them under.
 */
export function stillHolds(n: notifications.DueNotification, now: number): boolean {
  switch (n.kind) {
    case "finished":
      return true;
    case "refused":
      return (
        n.send_status === "sending" && n.halt_reason === "account" && n.halted_at === n.episode
      );
    case "stuck":
      return n.send_status === "sending";
    case "wedged":
      return isWedged({ ...n, status: n.send_status });
    case "missed":
      return n.send_status === "scheduled"
        ? n.fire_at < now - MISSED_THRESHOLD_MS
        : n.started_at !== null && n.started_at - n.fire_at > MISSED_THRESHOLD_MS;
  }
}

export async function notifyPublisher(env: AppEnv, budget: Budget): Promise<void> {
  const config = getConfig(env);
  const db = metered(env.DB, budget);
  const now = Date.now();

  await notifications.recordNotifications(db, now);
  const room = Math.min(
    MAX_PER_TICK,
    Math.floor((budget.left - (OPEN_COST - 1)) / EACH_COST),
    budget.queriesLeft - (OPEN_COST - 1),
  );
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
    if (!stillHolds(n, Date.now())) {
      await notifications.recordNotificationOutcome(db, n, { status: "cleared" }, Date.now());
      continue;
    }
    const key = `${n.send_id}-${n.kind}-${n.episode}`;
    budget.request(); // the channel's request, which counts whether or not it succeeds
    try {
      await notifier.send(to, composeNotification(n, config), key);
      await notifications.recordNotificationOutcome(db, n, { status: "sent" }, Date.now());
      log.info("notify.sent", { sendId: n.send_id, kind: n.kind, channel: notifier.channel });
    } catch (err) {
      const error = errorText(err);
      const giveUp = n.attempts + 1 >= MAX_NOTIFY_ATTEMPTS;
      log.warn("notify.failed", {
        sendId: n.send_id,
        kind: n.kind,
        channel: notifier.channel,
        error,
        giveUp,
      });
      await notifications.recordNotificationOutcome(
        db,
        n,
        { status: "unsent", error, giveUp },
        Date.now(),
      );
    }
  }
}
