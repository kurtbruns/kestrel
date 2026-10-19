/** Authed subscriber admin routes. */

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { freePlanListNotice, pastFreePlanList } from "../../shared/free_plan";
import type {
  EraseResponse,
  SubscribeResponse,
  SubscriberListResponse,
  SubscriberResponse,
} from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { onFreePlanLimits } from "../env";
import { fieldError, optString, readJsonObject } from "../lib/body";
import { HttpError, json, notFound, refusal } from "../lib/errors";
import { listPage, parseListParams } from "../lib/list";
import { log } from "../lib/log";
import type { RequestContext } from "../router";
import { param } from "../router";
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
  log.info("subscriber.erased", { deliveries: outcome.deliveries });
  const body: EraseResponse = {
    subscriber: await subscribers.withSuppression(c.env.DB, outcome.subscriber),
    deliveries: outcome.deliveries,
  };
  return json(body);
}
