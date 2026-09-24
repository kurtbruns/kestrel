/**
 * What is wrong with a send, or worth knowing, and what a person can do about it (SPEC §8,
 * §12): the one server function every route reads, so the list, the watch, the feed, and
 * Claude never derive a condition or an action of their own.
 *
 * A condition is a reading of the send row at a moment, never stored: missed and stuck by
 * the clock against the row's times; wedged by `isWedged`; refused and provider_unavailable
 * by the halt the send carries; bounce_spike by its confirmed bounces over its audience at
 * fire; remade by its last re-make against its last test. Each carries its severity, since
 * when (null when the record does not say), the server's words for it, and the action that
 * settles it, if the API has one. The actions are exactly what the server would accept on
 * the send right now, so a client offers a control only while pressing it would work.
 */

import {
  BOUNCE_SPIKE_MIN,
  BOUNCE_SPIKE_RATE,
  BOUNCE_SPIKE_RECENT_MS,
  type ConditionSeverity,
  refusalAdvice,
  type SendAction,
  type SendCondition,
  type SendSummary,
} from "../../shared/sends";
import { MISSED_THRESHOLD_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import { isWedged } from "./wedged";

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The provider's words as a sentence the copy around them can follow. */
function sentence(error: string | null): string {
  const text = error?.trim() || "no detail given";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

const action = (send: Pick<SendSummary, "id">, name: SendAction["name"]): SendAction => ({
  name,
  method: "POST",
  path: `/sends/${send.id}/${name}`,
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

/** The send's open conditions, most severe first. */
export function sendConditions(send: SendSummary, now: number): SendCondition[] {
  const out: SendCondition[] = [];

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
          "A template or identity change re-made this email after its last test. Send a new test to check the copy that will go out.",
        action: null,
        tested_at: send.tested_at,
      });
    }
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
    if (send.halt_reason === "account") {
      const advice = refusalAdvice(send.halt_cause);
      out.push({
        kind: "refused",
        severity: "action",
        since: send.halted_at,
        message: `The provider is refusing the account: ${sentence(send.halt_error)} ${advice} No one has been marked unsent, and the send resumes on its own at its next retry once the account is fixed.`,
        action: null,
        cause: send.halt_cause,
        error: send.halt_error ?? "",
        advice,
        retry_at: send.halt_retry_at,
      });
    } else if (send.halt_reason === "unavailable") {
      out.push({
        kind: "provider_unavailable",
        severity: "info",
        since: send.halted_at,
        message: `The provider is unavailable: ${sentence(send.halt_error)} The send retries on its own, spaced out the longer this lasts, and no one has been marked unsent.`,
        action: null,
        error: send.halt_error ?? "",
        retry_at: send.halt_retry_at,
      });
    }
    if (send.started_at !== null && now - send.started_at > STUCK_THRESHOLD_MS) {
      out.push({
        kind: "stuck",
        severity: "warn",
        since: send.started_at + STUCK_THRESHOLD_MS,
        message: `Still sending ${plural(minutes(now - send.started_at), "minute")} after it started; it may be retrying.`,
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

  return out.sort(bySeverity);
}
