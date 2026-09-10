/**
 * Apply normalized provider delivery events to the database.
 *
 * The provider seam (`parseWebhook`) verifies the webhook and turns it into a
 * transport-agnostic `DeliveryEvent[]`; this service is the ONLY thing that
 * mutates state from those events, so the rule lives in one place:
 *   - every event is recorded on the matching `deliveries` row (observability);
 *   - a HARD bounce or ANY complaint also adds a suppression (spec §6, §12), so
 *     the address is dropped from every future audience (I1/I2).
 * Soft (transient) bounces are recorded but never suppress.
 */

import { markDeliveryEvent } from "../db/sends";
import { addSuppression } from "../db/subscribers";
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

  for (const e of events) {
    await markDeliveryEvent(db, {
      providerId: e.providerId,
      email: e.email,
      event: e.type,
      detail: eventDetail(e),
      at: now,
    });
    applied += 1;

    if (e.email && ((e.type === "bounced" && e.hard) || e.type === "complained")) {
      const reason = e.type === "bounced" ? "bounce" : "complaint";
      await addSuppression(db, e.email, reason, eventDetail(e) ?? undefined);
      suppressed += 1;
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
