// What one recipient's row came to on a send, in the record's words and swatch.

import type { DeliveryRecord } from "../../shared/sends";

/** A row's outcome: its label and the swatch its bucket's tile wears. */
export interface Outcome {
  label: string;
  sw: string;
}

/**
 * A row's outcome, derived from the same two facts the record's tiles bucket (the webhook
 * `event` winning over the send-loop `status`), so a row reads the same bucket (and reuses the
 * same swatch palette) as its tile. A bounce splits soft vs hard on `bounce_kind`, the
 * provider's permanent/transient signal frozen onto the row when the event landed (SPEC §8),
 * a fact of THIS send, not a read of the current suppression list. Null = unknown.
 */
export function deliveryOutcome(r: DeliveryRecord): Outcome {
  if (r.event === "delivered") {
    return { label: "Delivered", sw: "ok" };
  }
  if (r.event === "bounced") {
    if (r.bounce_kind === "hard") {
      return { label: "Hard bounce", sw: "warn" };
    }
    if (r.bounce_kind === "soft") {
      return { label: "Soft bounce", sw: "warn" };
    }
    return { label: "Bounce", sw: "warn" };
  }
  if (r.event === "complained") {
    return { label: "Complained", sw: "danger" };
  }
  switch (r.status) {
    case "unsent":
      return { label: "Unsent", sw: "neutral" };
    case "skipped":
      return { label: "Skipped", sw: "neutral" };
    case "accepted":
      return { label: "Accepted", sw: "sending" };
    default:
      return { label: "In flight", sw: "sending" };
  }
}
