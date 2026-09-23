/**
 * The notifications that tell the publisher, by email, when a send goes out or runs into a
 * problem (SPEC §8): recording each event once, and the delivery record the sweep keeps for them.
 *
 * Every read of the send here is of the record the send path already keeps, and nothing
 * here writes a send or a delivery: the table is downstream of the send path, never part
 * of it, so a notification that fails cannot change what a send does (I1 to I6).
 */

import type { HaltCause } from "../../shared/sends";
import type { NotificationKind, NotificationStatusView } from "../../shared/settings";
import { MISSED_THRESHOLD_MS, NOTIFY_HORIZON_MS, STUCK_THRESHOLD_MS } from "../lib/time";

export type { NotificationKind };

/** A notification that is due, with the send facts its email is written from. */
export interface DueNotification {
  send_id: string;
  kind: NotificationKind;
  episode: number;
  attempts: number;
  subject: string;
  send_status: string;
  fire_at: number;
  started_at: number | null;
  completed_at: number | null;
  halt_cause: HaltCause | null;
  halt_error: string | null;
  c_pending: number;
  c_in_flight: number;
  c_accepted: number;
  c_delivered: number;
  c_bounced: number;
  c_complained: number;
  c_skipped: number;
  c_unsent: number;
}

/** The (send, kind, episode) that names one notification. */
export type NotificationKey = Pick<DueNotification, "send_id" | "kind" | "episode">;

// A send whose loop has given up on it for now: nothing left to hand off, recipients in
// flight with an unknown fate, and no run holding it. The same test the watch applies
// (send/progress.ts), so the notification and the status surface agree on "wedged".
const WEDGED = `status = 'sending' AND c_pending = 0 AND c_in_flight > 0
                AND (locked_until IS NULL OR locked_until <= ?1)`;

/**
 * Record every event that has happened and has no notification yet, in one statement.
 * INSERT OR IGNORE on the (send, kind, episode) key is what makes a condition that
 * persists across ticks one notification rather than one a tick. A finished or late send
 * counts only within the horizon, so turning notifications on does not mail the history.
 * A send in flight too long is not also reported as stuck while the provider refuses the
 * account or it is wedged: those notifications already say why it is taking so long.
 */
export async function recordNotifications(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO notifications (send_id, kind, episode, created_at, updated_at)
         SELECT id, 'finished', 0, ?1, ?1 FROM sends
          WHERE status = 'sent' AND completed_at >= ?2
         UNION ALL
         SELECT id, 'refused', halted_at, ?1, ?1 FROM sends
          WHERE status = 'sending' AND halt_reason = 'account' AND halted_at IS NOT NULL
         UNION ALL
         SELECT id, 'missed', 0, ?1, ?1 FROM sends
          WHERE (status = 'scheduled' AND fire_at < ?1 - ?3)
             OR (status IN ('sending', 'sent') AND started_at >= ?2 AND started_at - fire_at > ?3)
         UNION ALL
         SELECT id, 'wedged', 0, ?1, ?1 FROM sends WHERE ${WEDGED}
         UNION ALL
         SELECT id, 'stuck', 0, ?1, ?1 FROM sends
          WHERE status = 'sending' AND started_at < ?1 - ?4
            AND halt_reason IS NOT 'account' AND NOT (${WEDGED})`,
    )
    .bind(now, now - NOTIFY_HORIZON_MS, MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS)
    .run();
}

/** The oldest pending notifications, at most `limit`, with the send facts to write them. */
export async function dueNotifications(db: D1Database, limit: number): Promise<DueNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT n.send_id, n.kind, n.episode, n.attempts,
              s.subject, s.status AS send_status, s.fire_at, s.started_at, s.completed_at,
              s.halt_cause, s.halt_error, s.c_pending, s.c_in_flight, s.c_accepted,
              s.c_delivered, s.c_bounced, s.c_complained, s.c_skipped, s.c_unsent
         FROM notifications n JOIN sends s ON s.id = n.send_id
        WHERE n.status = 'pending'
        ORDER BY n.created_at ASC, n.send_id ASC, n.kind ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<DueNotification>();
  return results;
}

// The set of keys as one JSON parameter, matched row by row (never a `?` per key; D1
// caps a statement's bound parameters).
const IN_KEYS = `EXISTS (SELECT 1 FROM json_each(?) k
                  WHERE json_extract(k.value, '$[0]') = notifications.send_id
                    AND json_extract(k.value, '$[1]') = notifications.kind
                    AND json_extract(k.value, '$[2]') = notifications.episode)`;

/**
 * Count an attempt on each of `keys` before it is tried, in one statement, so a try the
 * invocation never finished recording still counts toward the cap.
 */
export async function claimNotifications(
  db: D1Database,
  keys: NotificationKey[],
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications SET attempts = attempts + 1, updated_at = ?
        WHERE status = 'pending' AND ${IN_KEYS}`,
    )
    .bind(now, JSON.stringify(keys.map((k) => [k.send_id, k.kind, k.episode])))
    .run();
}

/**
 * Record how one try went: `sent`, or the channel's words for why not, which leaves it
 * pending for the next tick until `giveUp`, when it is recorded failed.
 */
export async function recordNotificationOutcome(
  db: D1Database,
  key: NotificationKey,
  outcome: { sent: true } | { sent: false; error: string; giveUp: boolean },
  now: number,
): Promise<void> {
  const status = outcome.sent ? "sent" : outcome.giveUp ? "failed" : "pending";
  await db
    .prepare(
      `UPDATE notifications SET status = ?, error = ?, updated_at = ?
        WHERE send_id = ? AND kind = ? AND episode = ?`,
    )
    .bind(status, outcome.sent ? null : outcome.error, now, key.send_id, key.kind, key.episode)
    .run();
}

/**
 * Close every pending notification as having had nowhere to go: no destination was set
 * when it came due. Closing them, rather than holding them, means setting a destination
 * later starts the notifications from that moment instead of mailing a backlog.
 */
export async function closeUnaddressed(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      "UPDATE notifications SET status = 'unaddressed', updated_at = ? WHERE status = 'pending'",
    )
    .bind(now)
    .run();
}

/**
 * How notifications have gone lately, for the settings surface: the last one delivered,
 * and the last failed try when it is newer than that, so a channel that has stopped
 * working shows until one gets through again.
 */
export async function notificationStatus(db: D1Database): Promise<NotificationStatusView> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT 'sent' AS which, n.kind, s.subject, n.updated_at AS at, NULL AS error
           FROM notifications n JOIN sends s ON s.id = n.send_id
          WHERE n.status = 'sent' ORDER BY n.updated_at DESC LIMIT 1)
       UNION ALL
       SELECT * FROM (
         SELECT 'failed' AS which, n.kind, s.subject, n.updated_at AS at, n.error
           FROM notifications n JOIN sends s ON s.id = n.send_id
          WHERE n.error IS NOT NULL AND n.status IN ('pending', 'failed')
          ORDER BY n.updated_at DESC LIMIT 1)`,
    )
    .all<{
      which: "sent" | "failed";
      kind: NotificationKind;
      subject: string;
      at: number;
      error: string | null;
    }>();
  const sent = results.find((r) => r.which === "sent");
  const failed = results.find((r) => r.which === "failed");
  return {
    lastSent: sent ? { kind: sent.kind, subject: sent.subject, at: sent.at } : null,
    lastFailure:
      failed && (!sent || failed.at > sent.at)
        ? { kind: failed.kind, subject: failed.subject, at: failed.at, error: failed.error ?? "" }
        : null,
  };
}
