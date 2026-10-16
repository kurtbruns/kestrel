/**
 * What is wrong with a send, or worth knowing, and what a person can do about it (SPEC §8,
 * §12): the one server function every route reads, so the list, the watch, the feed, and
 * Claude never derive a condition or an action of their own.
 *
 * A condition is a reading of the send row at a moment, never stored: missed by the clock
 * against the fire time; stuck by `stuckAt`, the clock against the send's last progress;
 * wedged by `isWedged`; refused and provider_unavailable
 * by the halt the send carries; bounce_spike by its confirmed bounces over its audience at
 * fire; no_receipts by its counters long after dispatch finished; remade by its last re-make against its last test; untested by a test never sent; daily_writes by its audience as
 * scheduled and what imports wrote on the UTC day it fires, on Workers Free's limits only.
 * Each carries its severity, since when (null when the record does not say), the server's
 * words for it, and the action that settles it, if the API has one. The actions are exactly what the server would accept on
 * the send right now, so a client offers a control only while pressing it would work.
 */

import type { WritesDay } from "../../shared/daily_writes";
import {
  BOUNCE_SPIKE_MIN,
  BOUNCE_SPIKE_RATE,
  BOUNCE_SPIKE_RECENT_MS,
  type ConditionSeverity,
  dailyWritesSendMessage,
  isSelfThrottled,
  NO_RECEIPTS_AFTER_MS,
  refusalAdvice,
  refusedMessage,
  type SendAction,
  type SendCondition,
  type SendSummary,
  sendSpendsDailyWrites,
  unavailableMessage,
} from "../../shared/sends";
import { MISSED_THRESHOLD_MS } from "../lib/time";
import { stuckAt } from "./stuck";
import { isWedged } from "./wedged";

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const action = (send: Pick<SendSummary, "id">, name: SendAction["name"]): SendAction => ({
  name,
  method: "POST",
  path: `/api/sends/${send.id}/${name}`,
});

/** Whether the send is still in its review window: scheduled, its fire time still ahead
 *  (SPEC §6). The cancel window closes at the fire time, whether or not the sweep has
 *  started the send. */
export function inWindow(send: Pick<SendSummary, "status" | "fire_at">, now: number): boolean {
  return send.status === "scheduled" && send.fire_at > now;
}

/** What the server would accept on the send right now: cancel and reschedule inside the
 *  review window, Resolve while it is wedged. */
export function sendActions(send: SendSummary, now: number): SendAction[] {
  if (inWindow(send, now)) {
    return [action(send, "cancel"), action(send, "reschedule")];
  }
  return isWedged(send) ? [action(send, "resolve")] : [];
}

const RANK: Record<ConditionSeverity, number> = { action: 0, warn: 1, info: 2 };

/** Most severe first, then by when each began. */
export function bySeverity<T extends Pick<SendCondition, "severity" | "since">>(
  a: T,
  b: T,
): number {
  return RANK[a.severity] - RANK[b.severity] || (a.since ?? 0) - (b.since ?? 0);
}

/**
 * The send's open conditions, most severe first. `day`: on Workers Free's limits, the UTC day
 * so far (what its imports wrote); null on any other deployment.
 */
export function sendConditions(
  send: SendSummary,
  now: number,
  day: WritesDay | null,
): SendCondition[] {
  const out: SendCondition[] = [];

  if (
    day !== null &&
    send.status === "scheduled" &&
    sendSpendsDailyWrites(send.recipient_count, send.fire_at, day)
  ) {
    out.push({
      kind: "daily_writes",
      severity: "warn",
      since: send.scheduled_at,
      message: dailyWritesSendMessage(send.recipient_count, send.fire_at, day),
      action: null,
      recipients: send.recipient_count,
    });
  }

  if (send.status === "scheduled" && send.fire_at + MISSED_THRESHOLD_MS < now) {
    out.push({
      kind: "missed",
      severity: "action",
      since: send.fire_at + MISSED_THRESHOLD_MS,
      message: `The fire time passed ${plural(minutes(now - send.fire_at), "minute")} ago and the send has not started, so the sweep that fires sends is not running. It goes out as soon as the sweep runs again.`,
      action: null,
    });
  }

  if (send.status === "scheduled" && send.remade_at !== null) {
    if (send.tested_at === null || send.tested_at < send.remade_at) {
      out.push({
        kind: "remade",
        severity: "info",
        since: send.remade_at,
        message:
          "The template or publication details changed this email’s look after your last test. Its content and send time are the same. Send a new test to check what will go out.",
        action: null,
        tested_at: send.tested_at,
      });
    }
  }

  // Never tested and never re-made: the test is the publisher's check on the frozen copy
  // (SPEC §6), so say none has been sent. A re-made send untested says `remade` instead.
  if (send.status === "scheduled" && send.tested_at === null && send.remade_at === null) {
    out.push({
      kind: "untested",
      severity: "info",
      since: send.scheduled_at,
      message:
        "No test of this email has been sent yet. Send yourself a test to check what will go out.",
      action: null,
    });
  }

  if (send.status === "sending") {
    if (isWedged(send)) {
      const n = send.c_in_flight;
      out.push({
        kind: "wedged",
        severity: "action",
        since: null,
        message: `The provider never answered for ${plural(n, "recipient")}, so whether ${n === 1 ? "it was" : "they were"} mailed is unknown, and sending again could mail ${n === 1 ? "it" : "them"} twice. The send cannot finish until ${n === 1 ? "it is" : "they are"} resolved.`,
        action: action(send, "resolve"),
        count: n,
      });
    }
    // A wedged send is no longer retried, whatever halt it last carried, so it does not
    // report one: only Resolve moves it.
    const retried = !isWedged(send);
    if (retried && send.halt_reason === "account") {
      out.push({
        kind: "refused",
        severity: "action",
        since: send.halted_at,
        message: refusedMessage(send.halt_cause, send.halt_error),
        action: null,
        cause: send.halt_cause,
        error: send.halt_error ?? "",
        advice: refusalAdvice(send.halt_cause),
        retry_at: send.halt_retry_at,
      });
    } else if (retried && send.halt_reason === "unavailable") {
      out.push({
        kind: "provider_unavailable",
        // A rate limit that outlasts any burst is the deployment's setting, which a person
        // fixes, so it is worth a look rather than only shown.
        severity: isSelfThrottled(send) ? "warn" : "info",
        since: send.halted_at,
        message: unavailableMessage(send),
        action: null,
        error: send.halt_error ?? "",
        retry_at: send.halt_retry_at,
      });
    }
    // In flight too long: nothing handed off for the threshold, and no halt or wedge to
    // explain it. A send that is handing off is never flagged, however long it takes.
    const stuck = stuckAt(send);
    if (stuck !== null && now > stuck) {
      const idle = now - (send.progress_at ?? send.started_at ?? now);
      out.push({
        kind: "stuck",
        severity: "warn",
        since: stuck,
        message: `Nothing has gone out for ${plural(minutes(idle), "minute")}, with no retry or provider problem to explain it. Sending may have stopped, or another send may be taking its turn. It picks up where it stopped, mailing no one twice.`,
        action: null,
      });
    }
  }

  if (
    send.status === "sent" &&
    send.completed_at !== null &&
    now - send.completed_at <= BOUNCE_SPIKE_RECENT_MS &&
    send.recipient_count > 0 &&
    send.c_bounced >= BOUNCE_SPIKE_MIN &&
    send.c_bounced / send.recipient_count >= BOUNCE_SPIKE_RATE
  ) {
    const rate = send.c_bounced / send.recipient_count;
    out.push({
      kind: "bounce_spike",
      severity: "warn",
      since: send.completed_at,
      message: `${send.c_bounced.toLocaleString("en-US")} of ${plural(send.recipient_count, "recipient")} bounced (${Math.round(100 * rate)}%), at or above the ${Math.round(100 * BOUNCE_SPIKE_RATE)}% at which providers put a sender under review. Check the addresses on its record.`,
      action: null,
      bounced: send.c_bounced,
      rate,
    });
  }

  // Not one receipt for anyone the provider took, an hour after the last was handed off:
  // the provider's events may not be reaching the app, so its bounces and complaints are
  // suppressing no one. Said as a possibility, since a send can be this quiet on its own.
  const heard = send.c_delivered + send.c_bounced + send.c_complained;
  if (
    send.status === "sent" &&
    send.completed_at !== null &&
    now - send.completed_at > NO_RECEIPTS_AFTER_MS &&
    now - send.completed_at <= BOUNCE_SPIKE_RECENT_MS &&
    send.c_accepted > 0 &&
    heard === 0
  ) {
    out.push({
      kind: "no_receipts",
      severity: "warn",
      since: send.completed_at + NO_RECEIPTS_AFTER_MS,
      message: `No delivery receipt has arrived for any of the ${plural(send.c_accepted, "recipient")} the provider took, ${plural(Math.round((now - send.completed_at) / 3_600_000) || 1, "hour")} after the send went out. The provider's events may not be reaching this app, so its bounces and complaints suppress no one. Check the webhook and the app's error log.`,
      action: null,
      accepted: send.c_accepted,
    });
  }

  return out.sort(bySeverity);
}
