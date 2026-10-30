/**
 * Whether email is getting out (SPEC §13): one row, written by every answer the provider gives
 * a test, a confirmation, a list send, or a notification, and by the account check
 * (`services/sending.ts` decides what an answer means). Each write is one statement, so a
 * contact costs the path that made it one query.
 *
 * Every write carries `at`, when the provider gave its answer, and applies only when no newer
 * answer has been applied (`observed_at`). Writes land in whatever order their paths finish,
 * so without that a sweep that met a refusal before the operator's fix, recording at its end,
 * could put refusing back after the test that proved the fix.
 *
 * It is an observation, like the provider's account, so it lives apart from the settings
 * row. A missing row reads as not proven yet: a database reset by hand starts there.
 */

import type {
  RefusalFoundBy,
  RefusingCause,
  SendingPurpose,
  SendingState,
} from "../../shared/provider";
import { accountNotice } from "./notifications";

/** The sending row as stored. */
export interface SendingRow {
  state: SendingState;
  /** When it last entered `state`. */
  since: number;
  lastAcceptedAt: number | null;
  lastAcceptedBy: SendingPurpose | null;
  refusalCause: RefusingCause | null;
  refusalFoundBy: RefusalFoundBy | null;
  refusalError: string | null;
  refusalAt: number | null;
  /** The causes the account check found that an email the provider took has since contradicted. */
  checkContradicted: RefusingCause[];
}

interface Raw {
  state: SendingState;
  since: number;
  last_accepted_at: number | null;
  last_accepted_by: SendingPurpose | null;
  refusal_cause: RefusingCause | null;
  refusal_found_by: RefusalFoundBy | null;
  refusal_error: string | null;
  refusal_at: number | null;
  check_contradicted: string;
}

/** The row, or null when there is none (read as not proven yet). */
export async function readSending(db: D1Database): Promise<SendingRow | null> {
  const r = await db.prepare("SELECT * FROM sending WHERE id = 1").first<Raw>();
  if (!r) {
    return null;
  }
  return {
    state: r.state,
    since: r.since,
    lastAcceptedAt: r.last_accepted_at,
    lastAcceptedBy: r.last_accepted_by,
    refusalCause: r.refusal_cause,
    refusalFoundBy: r.refusal_found_by,
    refusalError: r.refusal_error,
    refusalAt: r.refusal_at,
    checkContradicted: JSON.parse(r.check_contradicted) as RefusingCause[],
  };
}

/** Whether the row is a refusal the account check found, in SQL. */
const CHECK_REFUSING = "(state = 'refusing' AND refusal_found_by = 'account_check')";

/**
 * The provider took an email, answered at `at`: email is working, from then if it wasn't
 * already, and any refusal is over. A refusal the account check found that this contradicts
 * is remembered, so the same finding doesn't pause signups again while email goes out.
 */
export function acceptedStatement(
  db: D1Database,
  by: SendingPurpose,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sending (id, state, since, observed_at, last_accepted_at, last_accepted_by)
       VALUES (1, 'working', ?1, ?1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET
         since = CASE WHEN state = 'working' THEN since ELSE ?1 END,
         check_contradicted = CASE WHEN ${CHECK_REFUSING}
           THEN json_insert(check_contradicted, '$[#]', refusal_cause) ELSE check_contradicted END,
         state = 'working',
         observed_at = ?1,
         last_accepted_at = ?1,
         last_accepted_by = ?2,
         refusal_cause = NULL, refusal_found_by = NULL, refusal_error = NULL, refusal_at = NULL
       WHERE ?1 >= observed_at`,
    )
    .bind(at, by);
}

/**
 * The provider refused the account at `at`, or the account check found then that it would:
 * email is refusing, from then if it wasn't already, with this refusal's cause and words, so
 * the newest finding is the one shown. The last email taken is kept. The account check never
 * takes over a refusal an email met: that one lifts only when the provider takes an email,
 * which a clean reading must not undo (`clearCheckRefusal`).
 */
export function refusalStatement(
  db: D1Database,
  refusal: { cause: RefusingCause; foundBy: RefusalFoundBy; error: string },
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sending (id, state, since, observed_at, refusal_cause, refusal_found_by, refusal_error, refusal_at)
       VALUES (1, 'refusing', ?1, ?1, ?2, ?3, ?4, ?1)
       ON CONFLICT (id) DO UPDATE SET
         since = CASE WHEN state = 'refusing' THEN since ELSE ?1 END,
         state = 'refusing',
         observed_at = ?1,
         refusal_cause = ?2, refusal_found_by = ?3, refusal_error = ?4, refusal_at = ?1
       WHERE ?1 >= observed_at
         AND (?3 <> 'account_check' OR state <> 'refusing' OR refusal_found_by = 'account_check')`,
    )
    .bind(at, refusal.cause, refusal.foundBy, refusal.error);
}

/**
 * The account check read the account clean at `at`: a refusal it found itself lifts, back to
 * where email stood before it, working if the provider has ever taken an email and not proven
 * yet if not (SPEC §13), and the findings emails contradicted are forgotten, so a real one
 * later pauses signups again. A refusal an email met is left as it is. Whether it changed
 * anything.
 */
export async function clearCheckRefusal(db: D1Database, at: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE sending SET
         state = CASE WHEN ${CHECK_REFUSING}
           THEN CASE WHEN last_accepted_at IS NULL THEN 'unproven' ELSE 'working' END ELSE state END,
         since = CASE WHEN ${CHECK_REFUSING} THEN ?1 ELSE since END,
         refusal_error = CASE WHEN ${CHECK_REFUSING} THEN NULL ELSE refusal_error END,
         refusal_at = CASE WHEN ${CHECK_REFUSING} THEN NULL ELSE refusal_at END,
         refusal_found_by = CASE WHEN ${CHECK_REFUSING} THEN NULL ELSE refusal_found_by END,
         refusal_cause = CASE WHEN ${CHECK_REFUSING} THEN NULL ELSE refusal_cause END,
         observed_at = ?1,
         check_contradicted = '[]'
       WHERE id = 1 AND ?1 >= observed_at
         AND (${CHECK_REFUSING} OR check_contradicted <> '[]')`,
    )
    .bind(at)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Record that the provider took an email, answered at `at`. */
export async function recordAccepted(
  db: D1Database,
  by: SendingPurpose,
  at: number,
): Promise<void> {
  await acceptedStatement(db, by, at).run();
}

/**
 * Record a refusal of the account, found at `at`, and, when `tell`, that the publisher is to
 * be told by email that email isn't going out (SPEC §8), at most once a UTC day. One batch,
 * so the notice exists exactly when the refusal is recorded.
 */
export async function recordRefusal(
  db: D1Database,
  refusal: { cause: RefusingCause; foundBy: RefusalFoundBy; error: string },
  at: number,
  tell: boolean,
): Promise<void> {
  const write = refusalStatement(db, refusal, at);
  await (tell ? db.batch([write, accountNotice(db, "not_sending", at)]) : write.run());
}
