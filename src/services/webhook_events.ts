/**
 * Apply normalized provider delivery events to the database.
 *
 * The provider seam (`parseWebhook`) verifies the webhook and turns it into a
 * transport-agnostic `DeliveryEvent[]`; this service is the ONLY thing that
 * mutates state from those events, so the rule lives in one place:
 *   - every event is recorded on the matching `deliveries` row (observability);
 *   - a HARD bounce or ANY complaint also adds a suppression (spec §6, §10), so
 *     the address is dropped from every future audience (I1/I2).
 * Soft (transient) bounces are recorded but never suppress.
 *
 * Each call logs what it applied, aggregated per send (`receipt.applied`, and
 * `suppression.added` when it suppressed), never an address: the counts are the story.
 */

import { markDeliveryEvent } from "../db/sends";
import { addSuppression } from "../db/subscribers";
import { log } from "../lib/log";
import type { DeliveryEvent } from "../providers/types";

export interface ApplyResult {
  applied: number;
  suppressed: number;
}

export async function applyDeliveryEvents(
  db: D1Database,
  events: DeliveryEvent[],
): Promise<ApplyResult> {
  const now = Date.now();
  let applied = 0;
  let suppressed = 0;
  // Per send (the empty key for events that matched no delivery row), for the log lines.
  const bySend = new Map<
    string,
    {
      recorded: number;
      unchanged: number;
      delivered: number;
      bounced: number;
      complained: number;
      bounce: number;
      complaint: number;
    }
  >();

  for (const e of events) {
    const matched = await markDeliveryEvent(db, {
      providerId: e.providerId,
      email: e.email,
      event: e.type,
      detail: eventDetail(e),
      // The provider's permanent/transient signal, frozen onto the delivery row so the
      // record's soft/hard split is a per-send fact, not a read of global suppression.
      hard: e.type === "bounced" ? e.hard : undefined,
      at: now,
    });
    applied += 1;
    const tally = bySend.get(matched.sendId ?? "") ?? {
      recorded: 0,
      unchanged: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      bounce: 0,
      complaint: 0,
    };
    bySend.set(matched.sendId ?? "", tally);
    tally[e.type] += 1;
    if (matched.changes > 0) {
      tally.recorded += 1;
    } else {
      tally.unchanged += 1;
    }

    // Prefer the matched delivery row's address, the form the list stores; fall back to
    // the event's own when nothing matched (a test send or a confirmation email). An
    // id-keyed hard bounce or complaint thus still suppresses (I1) rather than slipping
    // through and letting the address be mailed again next post.
    const email = matched.email ?? e.email;
    if (email && ((e.type === "bounced" && e.hard) || e.type === "complained")) {
      const reason = e.type === "bounced" ? "bounce" : "complaint";
      await addSuppression(db, email, reason, eventDetail(e) ?? undefined);
      suppressed += 1;
      tally[reason] += 1;
    }
  }

  for (const [sendId, t] of bySend) {
    const tags = { sendId: sendId || undefined, matched: sendId !== "" };
    log.info("receipt.applied", {
      ...tags,
      delivered: t.delivered,
      bounced: t.bounced,
      complained: t.complained,
      recorded: t.recorded,
      unchanged: t.unchanged,
    });
    if (t.bounce + t.complaint > 0) {
      log.info("suppression.added", {
        ...tags,
        source: "webhook",
        count: t.bounce + t.complaint,
        bounce: t.bounce,
        complaint: t.complaint,
      });
    }
  }

  return { applied, suppressed };
}

function eventDetail(e: DeliveryEvent): string | null {
  if (e.type === "bounced") {
    return e.detail ?? (e.hard ? "hard bounce" : "soft bounce");
  }
  if (e.type === "complained") {
    return e.detail ?? "complaint";
  }
  return null;
}
