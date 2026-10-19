/**
 * Apply normalized provider delivery events to the database.
 *
 * The provider seam (`parseWebhook`) verifies the webhook and turns it into a
 * transport-agnostic `DeliveryEvent[]`; this service is the ONLY thing that
 * mutates state from those events, so the rule lives in one place:
 *   - every event is recorded on the matching `deliveries` row (observability);
 *   - a HARD bounce also adds a suppression (SPEC §10), so the address is dropped from
 *     every future audience (I1);
 *   - a complaint unsubscribes its subscriber (SPEC §7), the reader's own act through
 *     their mail provider, whatever email it was about.
 * Soft (transient) bounces are recorded but never suppress.
 *
 * Each call logs what it applied, aggregated per send (`receipt.applied`, then
 * `suppression.added` when it suppressed and `subscriber.complained` when a complaint
 * reached a subscriber), never an address: the counts are the story.
 */

import { isErasedPlaceholder } from "../../shared/subscribers";
import { markDeliveryEvent } from "../db/sends";
import { addSuppression, type ComplaintOutcome, complain } from "../db/subscribers";
import { log } from "../lib/log";
import type { DeliveryEvent } from "../providers/types";

export interface ApplyResult {
  applied: number;
  suppressed: number;
  /** Subscribers a complaint unsubscribed. */
  unsubscribed: number;
}

export async function applyDeliveryEvents(
  db: D1Database,
  events: DeliveryEvent[],
): Promise<ApplyResult> {
  const now = Date.now();
  let applied = 0;
  let suppressed = 0;
  let unsubscribed = 0;
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
      complaint: Record<ComplaintOutcome, number>;
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
      complaint: { unsubscribed: 0, no_subscriber: 0 },
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
    // id-keyed hard bounce or complaint thus still acts (I1, I2) rather than slipping
    // through and letting the address be mailed again next post. A row an erasure left holds
    // a placeholder, not an address, so the event's own address is the one acted on, and
    // with no address in the event there is nothing to act on.
    const email =
      matched.email !== null && !isErasedPlaceholder(matched.email) ? matched.email : e.email;
    if (email && e.type === "bounced" && e.hard) {
      await addSuppression(db, email, "bounce", eventDetail(e) ?? undefined);
      suppressed += 1;
      tally.bounce += 1;
    } else if (email && e.type === "complained") {
      // One matching no delivery (a confirmation email, or a test) applies to whoever holds
      // the address, as one about a post does.
      const outcome = await complain(db, email);
      unsubscribed += outcome === "unsubscribed" ? 1 : 0;
      tally.complaint[outcome] += 1;
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
    if (t.bounce > 0) {
      log.info("suppression.added", { ...tags, source: "webhook", count: t.bounce });
    }
    const c = t.complaint;
    if (c.unsubscribed + c.no_subscriber > 0) {
      log.info("subscriber.complained", {
        ...tags,
        count: c.unsubscribed + c.no_subscriber,
        unsubscribed: c.unsubscribed,
        no_subscriber: c.no_subscriber,
      });
    }
  }

  return { applied, suppressed, unsubscribed };
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
