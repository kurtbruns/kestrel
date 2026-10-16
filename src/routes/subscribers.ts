/** Authed subscriber admin routes. */

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { freePlanListNotice, pastFreePlanList } from "../../shared/free_plan";
import type {
  EraseResponse,
  ErasureAcknowledgementRequired,
  SubscribeResponse,
  SubscriberListResponse,
  SubscriberResponse,
} from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { onFreePlanLimits } from "../env";
import { fieldError, optBoolean, optString, readJsonObject } from "../lib/body";
import { HttpError, json, notFound, refusal } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { log } from "../lib/log";
import { requireConnectedProvider } from "../providers";
import type { RequestContext } from "../router";
import { param } from "../router";
import { requestSubscription } from "../services/subscriptions";

export async function create(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const raw = optString(body, "email");
  const acknowledged = optBoolean(body, "acknowledge_erasure") === true;
  const email = raw === undefined ? "" : normalizeEmail(raw);
  if (!email || !isValidEmail(email)) {
    throw fieldError("email", "Enter a valid email address.");
  }
  // An erased person may come back, but by their own wish (SPEC §7): the publisher adding
  // them is asked first. Only here; the public form is the person asking for themselves.
  if (!acknowledged) {
    requireConnectedProvider(c.config);
    const suppression = await subscribers.suppressionOf(c.env.DB, email);
    if (suppression?.reason === subscribers.ERASED) {
      const details: Omit<ErasureAcknowledgementRequired, "error" | "message"> = {
        erased_at: suppression.created_at,
      };
      throw refusal(
        409,
        "erasure_acknowledgement_required",
        `${email} was erased at the person’s request. Send a confirmation only if they have asked to join again; confirming it lifts the erasure. To send it, add acknowledge_erasure: true.`,
        details,
      );
    }
  }
  const outcome = await requestSubscription(c, email);
  if (outcome.kind === "failed") {
    throw new HttpError(
      502,
      "confirmation_not_sent",
      outcome.delivered === "unknown"
        ? `No answer from the email provider, so the confirmation may not have reached ${email}: ${outcome.error}`
        : `The email provider refused the confirmation to ${email}: ${outcome.error}`,
    );
  }
  const response: SubscribeResponse = { subscriber: outcome.subscriber, action: outcome.action };
  return json(response, outcome.action === "created" ? 201 : 200);
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
  const [counts, total, rows] = await Promise.all([
    subscribers.counts(c.env.DB),
    subscribers.countSubscribers(c.env.DB, filter),
    subscribers.listSubscribers(c.env.DB, filter, page),
  ]);
  // Annotate each row with its suppression reason (if any), so the list can show WHY
  // an address is suppressed — bounced / complaint / manual — with one lookup for the
  // page's own addresses.
  const suppressions = await subscribers.suppressionsFor(
    c.env.DB,
    rows.map((r) => r.email),
  );
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

/**
 * Authed admin erasure (SPEC §7): the subscriber's row goes, their past delivery rows show
 * an erased recipient, and the address stays only as a do-not-contact suppression. Not
 * undoable, and a repeat finds no subscriber (404), since nothing is kept to know the id by.
 */
export async function erase(c: RequestContext): Promise<Response> {
  const outcome = await subscribers.erase(c.env.DB, param(c, "id"));
  if (outcome.kind === "not_found") {
    throw notFound("subscriber");
  }
  if (outcome.kind === "in_flight") {
    throw refusal(
      409,
      "run_in_progress",
      "A send is handing this subscriber to the email provider right now, so they can’t be erased this moment. Try again in a minute.",
    );
  }
  log.info("subscriber.erased", { deliveries: outcome.erased.deliveries });
  const body: EraseResponse = { erased: outcome.erased };
  return json(body);
}
