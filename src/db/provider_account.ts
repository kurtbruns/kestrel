/**
 * What the email provider's account last said about itself (SPEC §9): one row, written by the
 * sweep's account check (`services/provider_status.ts`) and read by the provider route and the
 * send loop's rate.
 *
 * It is an observation, not a preference, so it lives apart from the settings row. A failed
 * check records only that it tried (`attempted_at`, `outcome`) and keeps the last answer, so an
 * outage never wipes what the app knew. The answer is a JSON blob with its own camelCase keys,
 * so a new fact is a code change, not a migration, and a release rolled back still reads it.
 */

import type { AccountEnforcement, ProductionReview } from "../../shared/provider";

/** How the last check went: an answer, a key not allowed to ask, or no usable answer. */
export type AccountCheckOutcome = "ok" | "permission" | "unreachable";

/** The account's answer, as the check keeps it. */
export interface AccountAnswer {
  productionAccess: boolean;
  review: ProductionReview | null;
  reviewCase: string | null;
  maxSendRate: number;
  /** Null when unlimited. */
  max24HourSend: number | null;
  sentLast24Hours: number;
  enforcement: AccountEnforcement | null;
  sendingEnabled: boolean;
  /**
   * The sending identity's default configuration set: its name, or null when it has none.
   * Absent when the check didn't look, because `SES_CONFIGURATION_SET` names a set or the key
   * isn't allowed to read the identity.
   */
  identityConfigurationSet?: { name: string | null };
}

export interface ProviderAccountRow {
  attemptedAt: number;
  outcome: AccountCheckOutcome;
  /** When `answer` was given; null when there has never been one. */
  checkedAt: number | null;
  answer: AccountAnswer | null;
}

interface RawRow {
  attempted_at: number;
  outcome: AccountCheckOutcome;
  checked_at: number | null;
  answer: string | null;
}

/** The row, or null before the first check. */
export async function readProviderAccount(db: D1Database): Promise<ProviderAccountRow | null> {
  const r = await db
    .prepare("SELECT attempted_at, outcome, checked_at, answer FROM provider_account WHERE id = 1")
    .first<RawRow>();
  if (!r) {
    return null;
  }
  return {
    attemptedAt: r.attempted_at,
    outcome: r.outcome,
    checkedAt: r.checked_at,
    answer: r.answer === null ? null : (JSON.parse(r.answer) as AccountAnswer),
  };
}

/** Record a check that got an answer, replacing the last one. */
export async function recordAnswer(
  db: D1Database,
  now: number,
  answer: AccountAnswer,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_account (id, attempted_at, outcome, checked_at, answer) VALUES (1, ?, 'ok', ?, ?)
       ON CONFLICT (id) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = 'ok',
         checked_at = excluded.checked_at, answer = excluded.answer`,
    )
    .bind(now, now, JSON.stringify(answer))
    .run();
}

/** Record a check that got no answer, keeping the last answer there was. */
export async function recordMiss(
  db: D1Database,
  now: number,
  outcome: Exclude<AccountCheckOutcome, "ok">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_account (id, attempted_at, outcome) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = excluded.outcome`,
    )
    .bind(now, outcome)
    .run();
}
