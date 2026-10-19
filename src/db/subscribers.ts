/** Subscriber + suppression queries, and audience selection (I1/I2). */
import { normalizeEmail } from "../../shared/email";
import {
  SIGNUP_ONLY_CAUSES,
  type SubscribeAction,
  type Subscriber,
  type SubscriberCounts,
  type SubscriberStatus,
  type Suppression,
  type SuppressionReason,
  type UnsubscribeCause,
} from "../../shared/subscribers";
import { newId, newToken } from "../lib/ids";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { unwrap } from "../lib/unwrap";
import { forgetDeliveries, idleFor } from "./erasure";

// The row shapes live in shared/ so the editor reads the same definitions; the names
// here are the Worker's own.
export type { SubscribeAction, SubscriberStatus };
export type SubscriberRow = Omit<Subscriber, "suppression" | "receives_posts">;

/** Subscribers as the API answers them, in the order given: each with its suppression, or
 *  null, and whether they receive posts (docs/API.md, principle 2: one shape on every route),
 *  in one read for them all. */
export async function withSuppressions(
  db: D1Database,
  rows: readonly SubscriberRow[],
): Promise<Subscriber[]> {
  const found = await suppressionsFor(
    db,
    rows.map((r) => r.email),
  );
  const by = new Map(found.map((s) => [s.email, s]));
  return rows.map((row) => {
    const sup = by.get(row.email);
    return {
      ...row,
      suppression: sup
        ? { reason: sup.reason, detail: sup.detail, created_at: sup.created_at }
        : null,
      // The audience rule (I1), stated once here so no client works it out: confirmed, minus
      // suppressed.
      receives_posts: row.status === "confirmed" && !sup,
    };
  });
}

/** One subscriber as the API answers it (`withSuppressions`). */
export async function withSuppression(db: D1Database, row: SubscriberRow): Promise<Subscriber> {
  return unwrap((await withSuppressions(db, [row]))[0], "subscriber view");
}
export type Counts = SubscriberCounts;
export type SuppressionRow = Suppression;

export function getByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<SubscriberRow>();
}

export function getById(db: D1Database, id: string): Promise<SubscriberRow | null> {
  return db.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first<SubscriberRow>();
}

/** Resolve a subscriber by their one-shot confirm token (double opt-in only). */
export function getByConfirmToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  return db
    .prepare("SELECT * FROM subscribers WHERE confirm_token = ?")
    .bind(token)
    .first<SubscriberRow>();
}

/** Resolve a subscriber by their durable unsubscribe token (the link in mail). */
export function getByUnsubToken(db: D1Database, token: string): Promise<SubscriberRow | null> {
  return db
    .prepare("SELECT * FROM subscribers WHERE unsub_token = ?")
    .bind(token)
    .first<SubscriberRow>();
}

/**
 * The subscriber row an address's confirmation is sent from: the existing one, or a new
 * pending row with no confirm token yet (none is armed until a confirmation carrying one
 * is accepted, see `armConfirmation`). `created` says whether this call made it, so a
 * refused first confirmation can take it back out (`dropUnarmed`). Never auto-confirms (I1).
 */
export async function ensureSubscriber(
  db: D1Database,
  email: string,
): Promise<{ subscriber: SubscriberRow; created: boolean }> {
  const res = await db
    .prepare(
      "INSERT INTO subscribers (id, email, status, unsub_token, created_at) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT (email) DO NOTHING",
    )
    .bind(newId(), email, newToken(), Date.now())
    .run();
  return {
    subscriber: unwrap(await getByEmail(db, email), "subscriber"),
    created: (res.meta.changes ?? 0) > 0,
  };
}

/**
 * Claim the right to send this subscriber a confirmation now: stamps `confirm_attempt_at`
 * only if the last attempt was at or before `quietSince`, and never for a confirmed
 * subscriber. One conditional write, so two requests racing inside the cooldown send one
 * confirmation between them. False means another went out too recently. The claim leaves
 * the current token and its age alone, so an old link is not made good again by it.
 */
export async function claimConfirmation(
  db: D1Database,
  id: string,
  now: number,
  quietSince: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET confirm_attempt_at = ? WHERE id = ? AND status <> 'confirmed' AND (confirm_attempt_at IS NULL OR confirm_attempt_at <= ?)",
    )
    .bind(now, id, quietSince)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Arm the confirm token a confirmation carried once the provider took it: the address is
 * pending again, and only this newest link confirms it. Rotating only here, never before
 * the send, means a refused confirmation leaves the last link that did arrive working.
 * `unsub_token` is deliberately left untouched so the unsubscribe link already delivered
 * in past posts keeps working (I2).
 *
 * Only the claim that sent it may arm it, and only if the subscriber is still in the state
 * the claim saw: a confirm or an unsubscribe that landed during the send wins, so an
 * unsubscribe is never quietly turned back into pending (I2). False when it did not arm.
 *
 * `unsubscribed_at` is kept: anyone can put an address back to pending through the public
 * form, so a pending row that once left must still read as having left until its owner
 * confirms. An import reads it, and never confirms such a row (SPEC §7). An erased person
 * signing up again holds no unsubscribe token or provenance, so they are given a new token
 * and read as joining here.
 */
export async function armConfirmation(
  db: D1Database,
  id: string,
  token: string,
  claimedAt: number,
  statusAtClaim: SubscriberStatus,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE subscribers SET status = 'pending', confirm_token = ?, confirm_sent_at = ?, confirmed_at = NULL, unsub_token = COALESCE(unsub_token, ?), origin = COALESCE(origin, 'kestrel'), opt_in = COALESCE(opt_in, 'double') WHERE id = ? AND confirm_attempt_at = ? AND status = ?",
    )
    .bind(token, claimedAt, newToken(), id, claimedAt, statusAtClaim)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Undo a `claimConfirmation` whose confirmation never went out, so the cooldown counts only
 * confirmations that were sent. A row `ensureSubscriber` made for this request (`created`)
 * is removed instead, so no pending subscriber is left holding a link nobody received.
 * Both are no-ops once a later claim has taken the row, so a racing request that is
 * sending to it keeps it.
 */
export async function releaseConfirmation(
  db: D1Database,
  id: string,
  claimedAt: number,
  previous: number | null,
  created: boolean,
): Promise<void> {
  if (created) {
    await db
      .prepare(
        "DELETE FROM subscribers WHERE id = ? AND confirm_attempt_at = ? AND status = 'pending' AND confirm_token IS NULL",
      )
      .bind(id, claimedAt)
      .run();
  }
  await db
    .prepare(
      "UPDATE subscribers SET confirm_attempt_at = ? WHERE id = ? AND confirm_attempt_at = ?",
    )
    .bind(previous, id, claimedAt)
    .run();
}

/**
 * Confirm a pending subscriber by their confirm token (double opt-in), if the link was sent
 * after `sentAfter`, since a link is only good for a limited time. Idempotent for an
 * already-confirmed token; refuses an unsubscribed one. The one-shot property comes from
 * the `status = 'pending'` guard, so the token is left in place (not cleared) and a
 * double-click still lands on the confirmed page rather than an "invalid link".
 *
 * The consent is then this app's own (SPEC §7): the subscriber reads as joining through its
 * double opt-in, not through any import that added them pending, and the evidence is the
 * IP the confirmation came from, when the request carried one. It is also what brings back
 * someone who left, whatever the cause, so the cause goes with it. A suppression on the
 * address is the publisher's to lift and is left alone.
 */
export async function confirm(
  db: D1Database,
  token: string,
  sentAfter: number,
  ip?: string | null,
): Promise<SubscriberRow | null> {
  const row = await getByConfirmToken(db, token);
  if (!row) {
    return null;
  }
  if (row.status === "confirmed") {
    return row;
  }
  if (
    row.status !== "pending" ||
    row.confirm_sent_at === null ||
    row.confirm_sent_at <= sentAfter
  ) {
    return null;
  }
  await db
    .prepare(
      "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, origin = 'kestrel', opt_in = 'double', import_id = NULL, consent_evidence = ?, unsubscribe_cause = NULL WHERE id = ? AND status = 'pending' AND confirm_token = ?",
    )
    .bind(Date.now(), ip ? JSON.stringify({ confirmed_ip: ip }) : null, row.id, token)
    .run();
  return getById(db, row.id);
}

/**
 * Leave the list (I2), immediate and idempotent: a pending or confirmed subscriber is
 * unsubscribed with `cause`. One who already left, unsubscribed or pending again until they
 * confirm, keeps the stronger cause (SPEC §7, Leaving); one still unsubscribed keeps when
 * they left.
 */
function leaveStatement(
  db: D1Database,
  where: string,
  cause: UnsubscribeCause,
  now: number,
  ...binds: unknown[]
): D1PreparedStatement {
  // The causes as `strongerCause` ranks them: an erasure over a complaint over the rest.
  return db
    .prepare(
      `UPDATE subscribers SET
         unsubscribed_at = CASE WHEN status = 'unsubscribed' THEN unsubscribed_at ELSE ?1 END,
         unsubscribe_cause = CASE
           WHEN unsubscribe_cause IS NULL THEN ?2
           WHEN unsubscribe_cause = 'erased' OR ?2 = 'erased' THEN 'erased'
           WHEN unsubscribe_cause = 'complaint' OR ?2 = 'complaint' THEN 'complaint'
           ELSE unsubscribe_cause END,
         status = 'unsubscribed'
       WHERE ${where}`,
    )
    .bind(now, cause, ...binds);
}

/** Unsubscribe by the durable unsub token, the reader's own act (I2). A confirm token will
 *  not resolve here, so it can never be used to unsubscribe. */
export async function unsubscribeByToken(
  db: D1Database,
  token: string,
): Promise<SubscriberRow | null> {
  const row = await getByUnsubToken(db, token);
  if (!row) {
    return null;
  }
  if (row.status === "unsubscribed") {
    return row;
  }
  await leaveStatement(db, "id = ?3", "reader", Date.now(), row.id).run();
  return getById(db, row.id);
}

/**
 * Unsubscribe by id, pending or confirmed: the authed admin action, for a request that
 * arrives out of band. Same immediate, idempotent effect as `unsubscribeByToken` (I2), with
 * the publisher as its cause; returns null for an unknown id.
 */
export async function unsubscribeById(db: D1Database, id: string): Promise<SubscriberRow | null> {
  const row = await getById(db, id);
  if (!row) {
    return null;
  }
  if (row.status === "unsubscribed") {
    return row;
  }
  await leaveStatement(db, "id = ?3", "publisher", Date.now(), row.id).run();
  return getById(db, row.id);
}

/** What a complaint did to its address: unsubscribed its subscriber, or found none. */
export type ComplaintOutcome = "unsubscribed" | "no_subscriber";

/**
 * A complaint is leaving (SPEC §7): it unsubscribes the address's subscriber with cause
 * `complaint`, whatever email it was about, keeping a stronger cause one who already left
 * holds. An address with no subscriber is left as it is.
 */
export async function complain(db: D1Database, email: string): Promise<ComplaintOutcome> {
  const address = normalizeEmail(email);
  const res = await leaveStatement(db, "email = ?3", "complaint", Date.now(), address).run();
  return (res.meta.changes ?? 0) > 0 ? "unsubscribed" : "no_subscriber";
}

/**
 * The subscriber an address belongs to when only the person's own sign-up may bring them
 * back (SPEC §7): one who left by a complaint or an erasure, unsubscribed or pending again
 * until they confirm. Null for anyone else.
 */
export async function signupOnly(db: D1Database, email: string): Promise<SubscriberRow | null> {
  const row = await getByEmail(db, email);
  // Whatever their status: one pending again after leaving has signed up through the form, and
  // only their own confirmation brings them back, so the publisher sends them nothing first.
  return row && row.unsubscribe_cause !== null && SIGNUP_ONLY_CAUSES.includes(row.unsubscribe_cause)
    ? row
    : null;
}

/** The two orthogonal axes a roster can be narrowed by: consent `status`, and the
 *  `suppressed` overlay (a separate table — a row can be `confirmed` AND suppressed),
 *  plus an email contains-search. `suppressed`: "only" keeps suppressed addresses,
 *  "hide" drops them, absent leaves both. */
export interface SubscriberFilter {
  status?: SubscriberStatus;
  search?: string;
  suppressed?: "only" | "hide";
}

/** The sortable columns exposed by `GET /api/subscribers` (see `parseListParams`). */
export const SUBSCRIBER_LIST_SPEC: ListSpec = {
  columns: {
    created_at: "created_at",
    confirmed_at: "confirmed_at",
    email: "email",
    status: "status",
  },
  defaultSort: "created_at",
  defaultDir: "desc",
};

// Shared WHERE for the roster list and its matching count, so the page total and the
// rows on it are filtered identically. Suppression is an overlay on the address, not a
// status (a bounce or a block can suppress an address whatever its consent state), so
// it filters by membership in the suppressions table.
function subscriberWhere(filter: SubscriberFilter): { clause: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.status) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.suppressed === "only") {
    where.push("email IN (SELECT email FROM suppressions)");
  } else if (filter.suppressed === "hide") {
    where.push("email NOT IN (SELECT email FROM suppressions)");
  }
  // Contains-search on email. Emails are stored normalized (trimmed, lowercased), so
  // match the term the same way; escape LIKE's own wildcards so `_`/`%` in an address
  // are literal.
  const term = filter.search?.trim().toLowerCase();
  if (term) {
    where.push("email LIKE ? ESCAPE '\\'");
    binds.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/** The filtered roster, one page's worth. Omit `page` for the legacy default (newest
 *  first, first 100) used by internal callers and tests. */
export async function listSubscribers(
  db: D1Database,
  filter: SubscriberFilter = {},
  page?: ListParams,
): Promise<SubscriberRow[]> {
  const { clause, binds } = subscriberWhere(filter);
  const order = page ? orderByClause(page, "id") : "ORDER BY created_at DESC, id DESC";
  const limit = page ? page.limit : 100;
  const offset = page ? page.offset : 0;
  const { results } = await db
    .prepare(`SELECT * FROM subscribers ${clause} ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<SubscriberRow>();
  return results;
}

/** How many subscribers match `filter` — the `page.total` for the roster list. */
export async function countSubscribers(
  db: D1Database,
  filter: SubscriberFilter = {},
): Promise<number> {
  const { clause, binds } = subscriberWhere(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM subscribers ${clause}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function counts(db: D1Database): Promise<Counts> {
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status")
    .all<{ status: SubscriberStatus; n: number }>();
  const c: Counts = { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 };
  for (const r of results) {
    if (r.status === "pending") {
      c.pending = r.n;
    } else if (r.status === "confirmed") {
      c.confirmed = r.n;
    } else if (r.status === "unsubscribed") {
      c.unsubscribed = r.n;
    }
  }
  // Suppressed subscribers, whatever their status, so the count is what the roster's
  // suppression facet shows. An address suppressed with no subscriber (a bounce an import
  // brought for someone it didn't add, a block on an address never on the list) is no
  // subscriber, and isn't counted.
  const sup = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM subscribers WHERE email IN (SELECT email FROM suppressions)",
    )
    .first<{ n: number }>();
  c.suppressed = sup?.n ?? 0;
  return c;
}

/** The authoritative send audience: confirmed subscribers minus suppressions (I1). */
export async function audienceEmails(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT email FROM subscribers WHERE status = 'confirmed' AND email NOT IN (SELECT email FROM suppressions) ORDER BY email ASC",
    )
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

/** How many addresses a send would reach now: confirmed minus suppressed, the same
 *  set `audienceEmails` lists, counted without loading it. */
export async function audienceCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM subscribers WHERE status = 'confirmed' AND email NOT IN (SELECT email FROM suppressions)",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function isSuppressed(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM suppressions WHERE email = ?").bind(email).first();
  return row !== null;
}

/** The address's suppression whole, as the API answers it, or null when it has none. */
export async function suppressionRow(
  db: D1Database,
  email: string,
): Promise<SuppressionRow | null> {
  return (await suppressionsFor(db, [email]))[0] ?? null;
}

/** What `erase` came to: done, with the subscriber as it left them and how many past
 *  delivery rows it rewrote; no such subscriber; or refused for now because a send run is
 *  handing the address to the provider. */
export type EraseOutcome =
  | { kind: "erased"; subscriber: SubscriberRow; deliveries: number }
  | { kind: "not_found" }
  | { kind: "in_flight" };

/**
 * Erase a subscriber (SPEC §7): unsubscribe them with cause `erased` and strip their row to the
 * address and when, which takes how they joined and the evidence for it along and discards
 * both tokens, so the link in every post they were sent matches no one; put a placeholder in
 * place of their address on every past delivery row (`forgetDeliveries`); and drop the words
 * from a bounce or block kept on the address, which may name them. A subscriber already erased
 * is answered as they stand, only any delivery row still naming them (an import's erasure that
 * a send run's lease held back) rewritten.
 *
 * One batch, so it all lands together or not at all. It is refused (`in_flight`) while a
 * send run holding its lease has one of the address's rows pending or dispatched, and every
 * write carries that condition, so a run that takes its lease between the check and the
 * batch is still caught. A pending row of a send between runs becomes the placeholder, which
 * no subscriber holds, so the send skips it (I2).
 */
export async function erase(db: D1Database, id: string): Promise<EraseOutcome> {
  const row = await getById(db, id);
  if (!row) {
    return { kind: "not_found" };
  }
  const email = row.email;
  const now = Date.now();
  const deliveries = await forgetDeliveries(db, [email], now);
  if (
    row.status === "unsubscribed" &&
    row.unsubscribe_cause === "erased" &&
    row.unsub_token === null
  ) {
    const statements = [...deliveries.rewrite, ...deliveries.move];
    const moved = statements.length === 0 ? [] : await db.batch(statements);
    return {
      kind: "erased",
      subscriber: row,
      deliveries: moved
        .slice(deliveries.rewrite.length)
        .reduce((n, r) => n + (r.meta.changes ?? 0), 0),
    };
  }
  const idle = idleFor("?1", "?2");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE subscribers SET status = 'unsubscribed', unsubscribe_cause = 'erased',
           created_at = ?2, unsubscribed_at = ?2, confirmed_at = NULL, confirm_token = NULL,
           confirm_sent_at = NULL, confirm_attempt_at = NULL, unsub_token = NULL,
           origin = NULL, opt_in = NULL, consent_evidence = NULL, import_id = NULL
         WHERE id = ?3 AND email = ?1 AND ${idle}`,
      )
      .bind(email, now, id),
    db
      .prepare(`UPDATE suppressions SET detail = NULL WHERE email = ?1 AND ${idle}`)
      .bind(email, now),
    ...deliveries.rewrite,
    ...deliveries.move,
  ]);
  const after = await getById(db, id);
  if (!after) {
    return { kind: "not_found" };
  }
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { kind: "in_flight" };
  }
  const moved = results.slice(2 + deliveries.rewrite.length);
  return {
    kind: "erased",
    subscriber: after,
    deliveries: moved.reduce((n, r) => n + (r.meta.changes ?? 0), 0),
  };
}

/**
 * Suppress an address from the provider's report, stored in its normalized form (trimmed,
 * lowercased) whatever the caller passes, since the audience filter compares exactly (I1).
 * One suppression per address, and the first one stands. On an address erased here the
 * provider's words are left out, since they may name the person (SPEC §7).
 */
export async function addSuppression(
  db: D1Database,
  email: string,
  reason: SuppressionReason,
  detail?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO suppressions (email, reason, detail, created_at)
       SELECT ?1, ?2, CASE WHEN EXISTS (SELECT 1 FROM subscribers WHERE email = ?1 AND status = 'unsubscribed' AND unsubscribe_cause = 'erased') THEN NULL ELSE ?3 END, ?4
       ON CONFLICT (email) DO NOTHING`,
    )
    .bind(normalizeEmail(email), reason, detail ?? null, Date.now())
    .run();
}

/**
 * The publisher's block (SPEC §7): a `manual` suppression. Like any suppression it never
 * replaces one the address already has, since the first one stands. Answers the suppression
 * that stands, and whether this added it.
 */
export async function block(
  db: D1Database,
  email: string,
  detail?: string,
): Promise<{ suppression: SuppressionRow; added: boolean }> {
  const address = normalizeEmail(email);
  // One batch, one transaction: nothing can clear the row between the insert and the read.
  const [insert, read] = await db.batch([
    db
      .prepare(
        "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'manual', ?, ?) ON CONFLICT (email) DO NOTHING",
      )
      .bind(address, detail ?? null, Date.now()),
    db.prepare("SELECT * FROM suppressions WHERE email = ?").bind(address),
  ]);
  const suppression = unwrap(read?.results[0] as SuppressionRow | undefined, "suppression");
  return { suppression, added: (insert?.meta.changes ?? 0) > 0 };
}

export async function listSuppressions(db: D1Database): Promise<SuppressionRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 1000")
    .all<SuppressionRow>();
  return results;
}

/** The suppressions on exactly these addresses, so a roster page is annotated from its
 *  own rows rather than from the capped `listSuppressions`. */
export async function suppressionsFor(
  db: D1Database,
  emails: readonly string[],
): Promise<SuppressionRow[]> {
  if (emails.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare("SELECT * FROM suppressions WHERE email IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(emails))
    .all<SuppressionRow>();
  return results;
}

/**
 * Lift an address's suppression, the publisher's deliberate act (SPEC §7), only while its
 * reason is still `reason`, so a lift asked for a bounce never lifts another reason that
 * arrived since. Answers whether it lifted.
 */
export async function liftSuppression(
  db: D1Database,
  email: string,
  reason: SuppressionReason,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM suppressions WHERE email = ? AND reason = ?")
    .bind(email, reason)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
