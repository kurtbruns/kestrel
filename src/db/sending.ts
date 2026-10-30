/**
 * Whether email is getting out (SPEC §9): one row, written by every answer the provider gives
 * a test, a confirmation, a list send, or a notification, and by the account check
 * (`services/sending.ts` decides what an answer means). Each write is one statement, so a
 * contact costs the path that made it one query.
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
  since: number;
  lastAcceptedAt: number | null;
  lastAcceptedBy: SendingPurpose | null;
  refusalCause: RefusingCause | null;
  refusalFoundBy: RefusalFoundBy | null;
  refusalError: string | null;
  refusalAt: number | null;
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
  };
}

/** The provider took an email: email is working, from now if it wasn't already, and any
 *  refusal is over. */
export function acceptedStatement(
  db: D1Database,
  by: SendingPurpose,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sending (id, state, since, last_accepted_at, last_accepted_by)
       VALUES (1, 'working', ?1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET
         since = CASE WHEN state = 'working' THEN since ELSE ?1 END,
         state = 'working',
         last_accepted_at = ?1,
         last_accepted_by = ?2,
         refusal_cause = NULL, refusal_found_by = NULL, refusal_error = NULL, refusal_at = NULL`,
    )
    .bind(now, by);
}

/**
 * The provider refuses the account, or the account check found it would: email is refusing,
 * from now if it wasn't already, with this refusal's cause and words, so the newest finding
 * is the one shown. The last email taken is kept.
 */
export function refusalStatement(
  db: D1Database,
  refusal: { cause: RefusingCause; foundBy: RefusalFoundBy; error: string },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sending (id, state, since, refusal_cause, refusal_found_by, refusal_error, refusal_at)
       VALUES (1, 'refusing', ?1, ?2, ?3, ?4, ?1)
       ON CONFLICT (id) DO UPDATE SET
         since = CASE WHEN state = 'refusing' THEN since ELSE ?1 END,
         state = 'refusing',
         refusal_cause = ?2, refusal_found_by = ?3, refusal_error = ?4, refusal_at = ?1`,
    )
    .bind(now, refusal.cause, refusal.foundBy, refusal.error);
}

/** Record that the provider took an email. */
export async function recordAccepted(
  db: D1Database,
  by: SendingPurpose,
  now: number,
): Promise<void> {
  await acceptedStatement(db, by, now).run();
}

/**
 * Record a refusal of the account, and, when `tell`, that the publisher is to be told by
 * email that email isn't going out (SPEC §8), at most once a UTC day. One batch, so the
 * notice exists exactly when the refusal is recorded.
 */
export async function recordRefusal(
  db: D1Database,
  refusal: { cause: RefusingCause; foundBy: RefusalFoundBy; error: string },
  now: number,
  tell: boolean,
): Promise<void> {
  const write = refusalStatement(db, refusal, now);
  await (tell ? db.batch([write, accountNotice(db, "not_sending", now)]) : write.run());
}
