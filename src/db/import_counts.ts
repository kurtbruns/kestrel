/**
 * An import record's counts by outcome, read from its stored JSON (SPEC §7, §8) under the
 * outcomes' current names, whatever release wrote them.
 *
 * Releases before 1.13.0 stored six outcomes under older names. The record is permanent and
 * its counts are a JSON blob, so they're renamed as they're read rather than by a migration:
 * the previous release's Worker keeps serving between a migration and the deploy, and any
 * import it commits then writes the old names, which a one-time rewrite would never see.
 * Reading both names here is right for every record an older release wrote. The reverse is
 * not covered: an older release reads a record this one wrote with the renamed counts blank.
 */

import { IMPORT_OUTCOMES, type ImportOutcome, type OutcomeCounts } from "../../shared/imports";

// Each renamed outcome's name before 1.13.0.
const FORMER_NAMES: Partial<Record<ImportOutcome, string>> = {
  added_confirmed: "create_confirmed",
  confirmed_pending: "confirm_pending",
  unsubscribed: "mark_unsubscribed",
  added_unsubscribed: "create_unsubscribed",
  kept_suppressed: "blocked_by_suppression",
  suppressed: "suppression_added",
};

/** The counts a record's `counts` column holds, every outcome present, under its current name. */
export function readOutcomeCounts(json: string): OutcomeCounts {
  const stored = JSON.parse(json) as Record<string, number | undefined>;
  return Object.fromEntries(
    IMPORT_OUTCOMES.map((o) => {
      const former = FORMER_NAMES[o];
      return [o, stored[o] ?? (former === undefined ? undefined : stored[former]) ?? 0];
    }),
  ) as OutcomeCounts;
}
