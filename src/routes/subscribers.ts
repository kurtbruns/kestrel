/** Authed subscriber admin routes. */

import type {
  SubscribeResponse,
  SubscriberListResponse,
  SubscriberResponse,
} from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { isValidEmail, normalizeEmail } from "../db/subscribers";
import { badRequest, json, notFound } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import type { RequestContext } from "../router";
import { param } from "../router";
import { requestSubscription } from "../services/subscriptions";

export async function create(c: RequestContext): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await c.req.json()) as { email?: unknown };
  } catch {
    throw badRequest("JSON body with an 'email' is required");
  }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email || !isValidEmail(email)) {
    throw badRequest("a valid email is required");
  }
  const { subscriber, action } = await requestSubscription(c, email);
  const response: SubscribeResponse = { subscriber, action };
  return json(response, action === "created" ? 201 : 200);
}

export async function list(c: RequestContext): Promise<Response> {
  const emailQuery = c.url.searchParams.get("email");
  if (emailQuery) {
    const subscriber = await subscribers.getByEmail(c.env.DB, normalizeEmail(emailQuery));
    if (!subscriber) {
      throw notFound("subscriber");
    }
    return json({
      subscriber,
      suppressed: await subscribers.isSuppressed(c.env.DB, subscriber.email),
    });
  }
  const statusParam = c.url.searchParams.get("status") ?? undefined;
  const status =
    statusParam === "pending" || statusParam === "confirmed" || statusParam === "unsubscribed"
      ? statusParam
      : undefined;
  const search = c.url.searchParams.get("search") ?? undefined;
  // Suppression is an overlay, not a status, so it's its own facet (see subscriberWhere):
  // "only" narrows to suppressed addresses, "hide" drops them, absent leaves both.
  const suppressedParam = c.url.searchParams.get("suppressed");
  const suppressed =
    suppressedParam === "only" ? "only" : suppressedParam === "hide" ? "hide" : undefined;
  const filter = { status, search, suppressed } satisfies subscribers.SubscriberFilter;
  const page = parseListParams(c.url, subscribers.SUBSCRIBER_LIST_SPEC);
  const [counts, total, rows, suppressions] = await Promise.all([
    subscribers.counts(c.env.DB),
    subscribers.countSubscribers(c.env.DB, filter),
    subscribers.listSubscribers(c.env.DB, filter, page),
    subscribers.listSuppressions(c.env.DB),
  ]);
  // Annotate each row with its suppression reason (if any), so the list can show WHY
  // an address is suppressed — bounced / complaint / manual — without a per-row lookup.
  const suppressedBy = new Map(suppressions.map((s) => [s.email, s]));
  const annotated = rows.map((r) => {
    const sup = suppressedBy.get(r.email);
    return {
      ...r,
      suppressed: sup !== undefined,
      suppression_reason: sup?.reason ?? null,
      suppression_detail: sup?.detail ?? null,
    };
  });
  const body: SubscriberListResponse = {
    counts,
    subscribers: annotated,
    page: listPage(total, page),
  };
  return json(body);
}

export async function get(c: RequestContext): Promise<Response> {
  const subscriber = await subscribers.getById(c.env.DB, param(c, "id"));
  if (!subscriber) {
    throw notFound("subscriber");
  }
  const body: SubscriberResponse = {
    subscriber,
    suppressed: await subscribers.isSuppressed(c.env.DB, subscriber.email),
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
    subscriber,
    suppressed: await subscribers.isSuppressed(c.env.DB, subscriber.email),
  };
  return json(body);
}
