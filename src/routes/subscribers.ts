/** Authed subscriber admin routes. */

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { freePlanListNotice, pastFreePlanList } from "../../shared/free_plan";
import type {
  EraseResponse,
  SubscribeResponse,
  SubscriberDeliveriesResponse,
  SubscriberListResponse,
  SubscriberResponse,
  SubscriberStatus,
} from "../../shared/subscribers";
import * as sends from "../db/sends";
import * as subscribers from "../db/subscribers";
import { onFreePlanLimits } from "../env";
import { fieldError, optString, readJsonObject } from "../lib/body";
import { HttpError, json, notFound, refusal } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { log, whoActed } from "../lib/log";
import { decodePageCursor, encodePageCursor } from "../lib/page_cursor";
import { unwrap } from "../lib/unwrap";
import type { RequestContext } from "../router";
import { param } from "../router";
import { viewSends } from "../send/describe";
import { requestSubscription } from "../services/subscriptions";

export async function create(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const raw = optString(body, "email");
  const email = raw === undefined ? "" : normalizeEmail(raw);
  if (!email || !isValidEmail(email)) {
    throw fieldError("email", "Enter a valid email address.");
  }
  // Someone who reported the mail as spam or asked to be erased comes back only by their own
  // sign-up (SPEC §7), so no mail the publisher starts reaches them first. Only here; the
  // public form is the person asking for themselves.
  const leftForGood = await subscribers.signupOnly(c.env.DB, email);
  if (leftForGood) {
    throw refusal(
      "signup_required",
      `${email} ${leftForGood.unsubscribe_cause === "erased" ? "was erased at their request" : "reported your email as spam"}, so only their own sign-up brings them back. Ask them to subscribe through your subscribe page.`,
      { subscriber: await subscribers.withSuppression(c.env.DB, leftForGood) },
    );
  }
  const outcome = await requestSubscription(c, email);
  if (outcome.kind === "failed") {
    throw new HttpError(
      "confirmation_not_sent",
      outcome.delivered === "unknown"
        ? `No answer from the email provider, so the confirmation may not have reached ${email}: ${outcome.error}`
        : `The email provider refused the confirmation to ${email}: ${outcome.error}`,
    );
  }
  const response: SubscribeResponse = {
    subscriber:
      outcome.subscriber && (await subscribers.withSuppression(c.env.DB, outcome.subscriber)),
    action: outcome.action,
  };
  return json(response, outcome.action === "created" ? 201 : 200);
}

export async function list(c: RequestContext): Promise<Response> {
  const emailQuery = c.url.searchParams.get("email");
  if (emailQuery) {
    const subscriber = await subscribers.getByEmail(c.env.DB, normalizeEmail(emailQuery));
    if (!subscriber) {
      throw notFound("subscriber");
    }
    const body: SubscriberResponse = {
      subscriber: await subscribers.withSuppression(c.env.DB, subscriber),
    };
    return json(body);
  }
  // The router has held `status` and `suppressed` to the values the manifest declares.
  // Suppression is an overlay, not a status, so it's its own facet (see subscriberWhere):
  // "only" narrows to suppressed addresses, "hide" drops them, absent leaves both.
  const q = c.url.searchParams;
  const filter: subscribers.SubscriberFilter = {
    status: (q.get("status") as SubscriberStatus | null) ?? undefined,
    search: q.get("search") ?? undefined,
    suppressed: (q.get("suppressed") as subscribers.SuppressedFilter | null) ?? undefined,
  };
  const page = parseListParams(c.url, subscribers.SUBSCRIBER_LIST_SPEC);
  const [counts, total, rows] = await Promise.all([
    subscribers.counts(c.env.DB),
    subscribers.countSubscribers(c.env.DB, filter),
    subscribers.listSubscribers(c.env.DB, filter, page),
  ]);
  const body: SubscriberListResponse = {
    counts,
    // Each with its suppression, so the list says why an address isn't mailed: one lookup for
    // the page's own addresses.
    subscribers: await subscribers.withSuppressions(c.env.DB, rows),
    page: listPage(total, page),
    workers_plan_advice:
      onFreePlanLimits(c.config) && pastFreePlanList(counts.confirmed)
        ? freePlanListNotice(counts.confirmed)
        : null,
  };
  return json(body);
}

export async function get(c: RequestContext): Promise<Response> {
  const subscriber = await subscribers.getById(c.env.DB, param(c, "id"));
  if (!subscriber) {
    throw notFound("subscriber");
  }
  const body: SubscriberResponse = {
    subscriber: await subscribers.withSuppression(c.env.DB, subscriber),
  };
  return json(body);
}

/** How many sends one page of a subscriber's deliveries holds. The server sets it: each row is
 *  one send's view, so a page costs the same on every plan. */
export const SUBSCRIBER_DELIVERIES_PAGE = 25;

function readDeliveriesAfter(raw: string | null): sends.AddressDeliveriesAfter | null {
  if (raw === null) {
    return null;
  }
  const fields = decodePageCursor(raw);
  const fireAt = fields?.fire_at;
  const sendId = fields?.send;
  if (!Number.isSafeInteger(fireAt) || typeof sendId !== "string" || sendId === "") {
    throw fieldError("after", "after must be the next value a page of these deliveries returned");
  }
  return { fire_at: fireAt as number, send_id: sendId };
}

/**
 * The sends a subscriber's address was in (SPEC §8), newest first, each as the send's view
 * beside the address's row in its record, a page at a time. Read-only over the frozen records
 * (I3). An erased subscriber's past rows carry a placeholder, not the address, so none match.
 */
export async function deliveries(c: RequestContext): Promise<Response> {
  const subscriber = await subscribers.getById(c.env.DB, param(c, "id"));
  if (!subscriber) {
    throw notFound("subscriber");
  }
  const after = readDeliveriesAfter(c.url.searchParams.get("after"));
  // One row past the page says whether another follows, so the last page never comes empty.
  const read = await sends.deliveriesForAddress(
    c.env.DB,
    subscriber.email,
    after,
    SUBSCRIBER_DELIVERIES_PAGE + 1,
  );
  const page = read.slice(0, SUBSCRIBER_DELIVERIES_PAGE);
  const views = await viewSends(c.env, [...new Set(page.map((r) => r.send_id))]);
  const last = page.at(-1);
  const body: SubscriberDeliveriesResponse = {
    deliveries: page.flatMap(({ send_id, fire_at: _fireAt, ...delivery }) => {
      const send = views.get(send_id);
      return send ? [{ send, delivery }] : [];
    }),
    next:
      read.length > SUBSCRIBER_DELIVERIES_PAGE && last
        ? encodePageCursor({ fire_at: last.fire_at, send: last.send_id })
        : null,
  };
  return json(body);
}

/** Authed admin unsubscribe by id — immediate and idempotent (I2). */
export async function unsubscribe(c: RequestContext): Promise<Response> {
  const subscriber = await subscribers.unsubscribeById(c.env.DB, param(c, "id"));
  if (!subscriber) {
    throw notFound("subscriber");
  }
  const body: SubscriberResponse = {
    subscriber: await subscribers.withSuppression(c.env.DB, subscriber),
  };
  return json(body);
}

/**
 * Authed admin erasure (SPEC §7): the subscriber is unsubscribed by it and stripped to the
 * address, and their past delivery rows show an erased recipient. Not undoable; a repeat
 * answers the subscriber as the first one left them, changing nothing.
 */
export async function erase(c: RequestContext): Promise<Response> {
  const id = param(c, "id");
  const outcome = await subscribers.erase(c.env.DB, id);
  if (outcome.kind === "not_found") {
    throw notFound("subscriber");
  }
  if (outcome.kind === "in_flight") {
    // Nothing was erased, so the subscriber is still there to carry, as it now stands.
    const subscriber = await subscribers.getById(c.env.DB, id);
    throw refusal(
      "run_in_progress",
      "A send is handing this subscriber to the email provider right now, so they can’t be erased this moment. Try again in a minute.",
      { subscriber: subscriber && (await subscribers.withSuppression(c.env.DB, subscriber)) },
    );
  }
  // A repeat that changed nothing is no action, so it logs none.
  if (!outcome.unchanged) {
    log.info("subscriber.erased", {
      deliveries: outcome.deliveries,
      ...whoActed(unwrap(c.principal, "principal")),
    });
  }
  const body: EraseResponse = {
    subscriber: await subscribers.withSuppression(c.env.DB, outcome.subscriber),
    deliveries: outcome.deliveries,
  };
  return json(body);
}
