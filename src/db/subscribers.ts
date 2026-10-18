/** Subscriber + suppression queries, and audience selection (I1/I2). */
import { normalizeEmail } from "../../shared/email";
import {
  ERASED_PREFIX,
  type EraseResponse,
  type SubscribeAction,
  type Subscriber,
  type SubscriberCounts,
  type SubscriberStatus,
  type Suppression,
  type SuppressionReason,
} from "../../shared/subscribers";
import { newId, newToken } from "../lib/ids";
import { type ListParams, type ListSpec, orderByClause } from "../lib/list";
import { unwrap } from "../lib/unwrap";

// The row shapes live in shared/ so the editor reads the same definitions; the names
// here are the Worker's own.
export type { SubscribeAction, SubscriberStatus };
export type SubscriberRow = Subscriber;
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
 * confirms. An import reads it, and never confirms such a row (SPEC §7).
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
      "UPDATE subscribers SET status = 'pending', confirm_token = ?, confirm_sent_at = ?, confirmed_at = NULL WHERE id = ? AND confirm_attempt_at = ? AND status = ?",
    )
    .bind(token, claimedAt, id, claimedAt, statusAtClaim)
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
 * Confirming also lifts an `erased` suppression on the address (see `ERASED`), and only
 * when this confirm is the one that took effect. Any other suppression is the publisher's
 * to clear and is left alone.
 *
 * The consent is then this app's own (SPEC §7): the subscriber reads as joining through its
 * double opt-in, not through any import that added them pending, and the evidence is the
 * IP the confirmation came from, when the request carried one.
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
  const confirmedAt = Date.now();
  await db.batch([
    db
      .prepare(
        "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, origin = 'kestrel', opt_in = 'double', import_id = NULL, consent_evidence = ? WHERE id = ? AND status = 'pending' AND confirm_token = ?",
      )
      .bind(confirmedAt, ip ? JSON.stringify({ confirmed_ip: ip }) : null, row.id, token),
    db
      .prepare(
        "DELETE FROM suppressions WHERE email = ? AND reason = ? AND EXISTS (SELECT 1 FROM subscribers WHERE id = ? AND status = 'confirmed' AND confirmed_at = ?)",
      )
      .bind(row.email, ERASED, row.id, confirmedAt),
  ]);
  return getById(db, row.id);
}

/** Unsubscribe by the durable unsub token — immediate and idempotent (I2). A
 *  confirm token will not resolve here, so it can never be used to unsubscribe. */
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
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return getById(db, row.id);
}

/**
 * Unsubscribe by id — the authed admin action, for a request that arrives out
 * of band. Same immediate, idempotent effect as `unsubscribeByToken` (I2);
 * returns null for an unknown id.
 */
export async function unsubscribeById(db: D1Database, id: string): Promise<SubscriberRow | null> {
  const row = await getById(db, id);
  if (!row) {
    return null;
  }
  if (row.status === "unsubscribed") {
    return row;
  }
  await db
    .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return getById(db, row.id);
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
// status (a bounce or complaint can suppress an address whatever its consent state), so
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
  // suppression facet shows. An address suppressed with no subscriber (an erasure's marker,
  // a bounce an import brought for someone it didn't add) is no subscriber, and isn't counted.
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

/**
 * The suppression reason that marks an erased person (SPEC §7, Erasing a subscriber): the
 * address is kept only so it is never mailed by accident, and the person may still come
 * back by subscribing again, their own confirmation lifting the marker.
 */
export const ERASED: SuppressionReason = "erased";

/** The address's suppression reason and when it was set, or null when it has none. */
export function suppressionOf(
  db: D1Database,
  email: string,
): Promise<Pick<SuppressionRow, "reason" | "created_at"> | null> {
  return db
    .prepare("SELECT reason, created_at FROM suppressions WHERE email = ?")
    .bind(email)
    .first<Pick<SuppressionRow, "reason" | "created_at">>();
}

/** What an erasure did, as `EraseResponse` carries it. */
export type Erasure = EraseResponse["erased"];

/** What `erase` came to: done, no such subscriber (an erased one included), or refused for
 *  now because a send run is handing the address to the provider. */
export type EraseOutcome =
  | { kind: "erased"; erased: Erasure }
  | { kind: "not_found" }
  | { kind: "in_flight" };

/** `text` with every occurrence of `email` replaced by `placeholder`, matched whatever its
 *  case and leaving the rest of the text as it was; null stays null. */
function withoutAddress(text: string | null, email: string, placeholder: string): string | null {
  if (text === null) {
    return null;
  }
  const pattern = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return text.replace(pattern, placeholder);
}

/**
 * Erase a subscriber (SPEC §7): delete their row, which takes how they joined and the
 * evidence for it along; put one random placeholder, `erased:<hex>`, in place of their
 * address on every past delivery row, so each record still sums to its audience; and keep
 * the address only as an `erased` suppression with no detail. A suppression already there
 * stays as it is (a bounce is still a bounce), and an earlier erasure's marker takes this
 * one's time. A provider's words or message id on a delivery row that name the address get
 * the placeholder in its place too, in whatever case it was written, the rest of the text
 * kept as it was. A real provider's message id is opaque and never matches; the local
 * stand-in's spells out the address, and it is still unique with the placeholder in it.
 *
 * One batch, so it all lands together or not at all. It is refused (`in_flight`) while a
 * send run holding its lease has one of the address's rows pending or dispatched: that run
 * holds the real address in hand and would write the provider's answer, which may name it,
 * back onto the row. Every write carries that condition, so a run that takes its lease
 * between the check and the batch is still caught. A pending row of a send between runs
 * becomes the placeholder, which no subscriber holds, so the send skips it (I1).
 */
export async function erase(db: D1Database, id: string): Promise<EraseOutcome> {
  const row = await getById(db, id);
  if (!row) {
    return { kind: "not_found" };
  }
  const email = row.email;
  const now = Date.now();
  const placeholder = `${ERASED_PREFIX}${newToken(8)}`;
  // Through idx_deliveries_email: the rows whose provider text or id names the address.
  const { results } = await db
    .prepare("SELECT id, error, event_detail, provider_id FROM deliveries WHERE email = ?")
    .bind(email)
    .all<{
      id: number;
      error: string | null;
      event_detail: string | null;
      provider_id: string | null;
    }>();
  const rewritten = results.flatMap((r) => {
    const next = {
      id: r.id,
      error: withoutAddress(r.error, email, placeholder),
      event_detail: withoutAddress(r.event_detail, email, placeholder),
      provider_id: withoutAddress(r.provider_id, email, placeholder),
    };
    const changed =
      next.error !== r.error ||
      next.event_detail !== r.event_detail ||
      next.provider_id !== r.provider_id;
    return changed ? [next] : [];
  });
  // Every statement binds ?1 the address and ?2 the time, for this condition: no run holding
  // its lease has the address in hand.
  const idle =
    "NOT EXISTS (SELECT 1 FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.email = ?1 AND d.status IN ('pending', 'dispatched') AND s.locked_until >= ?2)";
  const field = (name: string) =>
    `${name} = (SELECT json_extract(value, '$.${name}') FROM json_each(?3) WHERE json_extract(value, '$.id') = deliveries.id)`;
  const [deleted, , , moved] = await db.batch([
    db
      .prepare(`DELETE FROM subscribers WHERE id = ?3 AND email = ?1 AND ${idle}`)
      .bind(email, now, id),
    db
      .prepare(
        `INSERT INTO suppressions (email, reason, detail, created_at) SELECT ?1, ?3, NULL, ?2 WHERE ${idle} ON CONFLICT (email) DO UPDATE SET created_at = excluded.created_at, detail = NULL WHERE suppressions.reason = excluded.reason`,
      )
      .bind(email, now, ERASED),
    db
      .prepare(
        `UPDATE deliveries SET ${field("error")}, ${field("event_detail")}, ${field("provider_id")} WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?3)) AND email = ?1 AND ${idle}`,
      )
      .bind(email, now, JSON.stringify(rewritten)),
    db
      .prepare(`UPDATE deliveries SET email = ?3 WHERE email = ?1 AND ${idle}`)
      .bind(email, now, placeholder),
  ]);
  if ((deleted?.meta.changes ?? 0) === 0) {
    return (await getById(db, id)) ? { kind: "in_flight" } : { kind: "not_found" };
  }
  const kept = await suppressionOf(db, email);
  return {
    kind: "erased",
    erased: { email, deliveries: moved?.meta.changes ?? 0, suppression: kept?.reason ?? ERASED },
  };
}

/** Whether a suppression forbids sending this address a confirmation. Every reason does
 *  except `erased`, whose person may subscribe again and whose confirmation lifts it. */
export async function blocksConfirmation(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM suppressions WHERE email = ? AND reason <> ?")
    .bind(email, ERASED)
    .first();
  return row !== null;
}

/** Suppress an address, stored in its normalized form (trimmed, lowercased) whatever
 *  the caller passes, since the audience filter compares exactly (I1). */
export async function addSuppression(
  db: D1Database,
  email: string,
  reason: SuppressionReason,
  detail?: string,
): Promise<void> {
  // One suppression per address, and the first one stands, except over an `erased` marker:
  // a bounce or complaint on an erased address must still stop it being sent confirmations.
  await db
    .prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, created_at = excluded.created_at WHERE suppressions.reason = ?",
    )
    .bind(normalizeEmail(email), reason, detail ?? null, Date.now(), ERASED)
    .run();
}

/**
 * The publisher's block (SPEC §7): a `manual` suppression. Unlike a bounce or complaint it
 * never replaces a suppression the address already has, an erasure's marker included: the
 * one there says more about the address, and a block over the marker would let clearing the
 * block lift an erasure. Answers the suppression that stands, and whether this added it.
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
 * Clear an address's suppression, the publisher's deliberate act (SPEC §7). An erasure's
 * marker is never cleared this way: only the person's own confirmation lifts it, so it
 * answers `erased` and leaves the marker in place.
 */
export async function clearSuppression(
  db: D1Database,
  email: string,
): Promise<"cleared" | "none" | "erased"> {
  const res = await db
    .prepare("DELETE FROM suppressions WHERE email = ? AND reason <> ?")
    .bind(email, ERASED)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    return "cleared";
  }
  return (await suppressionOf(db, email))?.reason === ERASED ? "erased" : "none";
}
