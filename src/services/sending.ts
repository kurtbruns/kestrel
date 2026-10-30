/**
 * Whether email is getting out (SPEC §9), and what follows from it: what the provider's
 * answer to an email says about the account, the view both clients read on
 * `GET /api/provider`, and whether the public form takes signups (SPEC §7).
 *
 * Every path that hands the provider an email records its answer here: a test, a
 * confirmation, a list send (once a run, through the sweep), and a notification through the
 * provider. An email the provider took makes it working; a refusal of the account for a cause
 * that won't clear on its own (`REFUSING_CAUSES`) makes it refusing; any other answer, the
 * sandbox refusing one reader or a throttle, says nothing about the account and changes
 * nothing. The account check can find a refusal too (`provider_status.ts`), but only an email
 * the provider takes ever makes it working again.
 *
 * Recording is downstream of the email: a failure to record never changes what the path
 * answers, and nothing that decides whether to send reads the state. The public form and the
 * reader pages read it to decide whether to take signups, which sends nothing.
 */

import {
  isRefusingCause,
  type RefusalFoundBy,
  type RefusingCause,
  type SendingPurpose,
  type SendingView,
  type SignupsState,
} from "../../shared/provider";
import { refusalAdvice } from "../../shared/sends";
import { readSending, recordAccepted, recordRefusal, type SendingRow } from "../db/sending";
import type { Config } from "../env";
import { errorText, log } from "../lib/log";
import type { BatchHalt, SendBatchResult } from "../providers/types";

/** What one answer from the provider says about the account: it took an email, it refuses
 *  the account, or neither. */
export type ContactOutcome =
  | { kind: "accepted" }
  | { kind: "refused"; cause: RefusingCause; error: string }
  | { kind: "none" };

/**
 * What a provider's answer says about the account. A refusal outranks an email taken in the
 * same answer, since it is the provider's later word: SES answers a call's requests in order.
 */
export function contactOutcome(result: SendBatchResult): ContactOutcome {
  const halt = result.halt;
  if (halt && halt.reason === "account" && isRefusingCause(halt.cause)) {
    return { kind: "refused", cause: halt.cause, error: halt.error };
  }
  if (result.kind === "answered" && result.results.some((r) => r.accepted)) {
    return { kind: "accepted" };
  }
  return { kind: "none" };
}

/** A send loop run's outcome, as `contactOutcome` reads one answer: its refusal of the
 *  account, if any, else whether it took anyone. */
export function runOutcome(accepted: number, refusal: BatchHalt | null): ContactOutcome {
  if (refusal && refusal.reason === "account" && isRefusingCause(refusal.cause)) {
    return { kind: "refused", cause: refusal.cause, error: refusal.error };
  }
  return accepted > 0 ? { kind: "accepted" } : { kind: "none" };
}

/**
 * Record what an email's answer says about the account. `tell` asks for the publisher to be
 * told by email of a refusal, for an email nobody was there to see refused (a reader's
 * signup); one a person sent sees its refusal as it happens. Caught and logged, so recording
 * never changes the path's answer; `db` may be metered by the caller.
 */
export async function noteContact(
  db: D1Database,
  config: Config,
  purpose: SendingPurpose,
  outcome: ContactOutcome,
  now: number,
  tell = false,
): Promise<void> {
  if (config.provider === "none" || outcome.kind === "none") {
    return;
  }
  try {
    if (outcome.kind === "accepted") {
      await recordAccepted(db, purpose, now);
      return;
    }
    await noteRefusal(
      db,
      { cause: outcome.cause, foundBy: purpose, error: outcome.error },
      now,
      tell,
    );
  } catch (err) {
    log.error("sending.record_failed", { purpose, error: errorText(err) });
  }
}

/**
 * The provider's answers over one stretch of work that records them together, such as a
 * sweep tick, so its sends and notifications cost one statement between them, held for it
 * up front, rather than one each out of the budget the sends run on. The latest answer that
 * says anything stands, as it would had each been recorded in turn.
 */
export class Contacts {
  private latest: { purpose: SendingPurpose; outcome: ContactOutcome } | null = null;

  add(purpose: SendingPurpose, outcome: ContactOutcome): void {
    if (outcome.kind !== "none") {
      this.latest = { purpose, outcome };
    }
  }

  /** Record the latest answer, if any: at most one statement. */
  async record(db: D1Database, config: Config, now: number): Promise<void> {
    if (this.latest) {
      await noteContact(db, config, this.latest.purpose, this.latest.outcome, now);
      this.latest = null;
    }
  }
}

/** Record a refusal of the account, found by an email or by the account check. */
export async function noteRefusal(
  db: D1Database,
  refusal: { cause: RefusingCause; foundBy: RefusalFoundBy; error: string },
  now: number,
  tell: boolean,
): Promise<void> {
  await recordRefusal(db, refusal, now, tell);
  log.warn("sending.refusing", { cause: refusal.cause, foundBy: refusal.foundBy });
}

/** The state as both clients read it; null while no provider is connected. A missing row is
 *  not proven yet. */
export function sendingView(config: Config, row: SendingRow | null): SendingView | null {
  if (config.provider === "none") {
    return null;
  }
  if (!row) {
    return { state: "unproven", since: 0, last_accepted: null, refusal: null };
  }
  return {
    state: row.state,
    since: row.since,
    last_accepted:
      row.lastAcceptedAt !== null && row.lastAcceptedBy !== null
        ? { at: row.lastAcceptedAt, by: row.lastAcceptedBy }
        : null,
    refusal:
      row.state === "refusing" && row.refusalCause && row.refusalFoundBy
        ? {
            cause: row.refusalCause,
            found_by: row.refusalFoundBy,
            error: row.refusalError ?? "",
            advice: refusalAdvice(row.refusalCause),
            at: row.refusalAt ?? row.since,
          }
        : null,
  };
}

/**
 * Whether the public form takes signups (SPEC §7): only while email is working, in the
 * sandbox too, where the form is what AWS's reviewer and the operator's own checks need.
 * Paused while it is refusing; not open yet with no provider or before it is proven.
 */
export function signupsState(view: SendingView | null): SignupsState {
  switch (view?.state) {
    case "working":
      return "open";
    case "refusing":
      return "paused";
    default:
      return "not_open";
  }
}

/** Whether the public form takes signups now, read from the database (one query, none while
 *  no provider is connected). The subscribe page, the home page, and the archive all ask this,
 *  so they never disagree. */
export async function readSignups(db: D1Database, config: Config): Promise<SignupsState> {
  if (config.provider === "none") {
    return "not_open";
  }
  return signupsState(sendingView(config, await readSending(db)));
}
