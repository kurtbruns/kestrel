/** Authed subscriber admin routes. */
import type { RequestContext } from "../router";
import { param } from "../router";
import { badRequest, json, notFound } from "../lib/errors";
import * as subscribers from "../db/subscribers";
import { isValidEmail, normalizeEmail } from "../db/subscribers";
import { requestSubscription } from "../services/subscriptions";

export async function create(c: RequestContext): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await c.req.json()) as { email?: unknown };
  } catch {
    throw badRequest("JSON body with an 'email' is required");
  }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email || !isValidEmail(email)) throw badRequest("a valid email is required");
  const { subscriber, action } = await requestSubscription(c, email);
  return json({ subscriber, action }, action === "created" ? 201 : 200);
}

export async function list(c: RequestContext): Promise<Response> {
  const emailQuery = c.url.searchParams.get("email");
  if (emailQuery) {
    const subscriber = await subscribers.getByEmail(c.env.DB, normalizeEmail(emailQuery));
    if (!subscriber) throw notFound("subscriber");
    return json({ subscriber, suppressed: await subscribers.isSuppressed(c.env.DB, subscriber.email) });
  }
  const statusParam = c.url.searchParams.get("status") ?? undefined;
  const status =
    statusParam === "pending" || statusParam === "confirmed" || statusParam === "unsubscribed"
      ? statusParam
      : undefined;
  const [counts, rows] = await Promise.all([
    subscribers.counts(c.env.DB),
    subscribers.listSubscribers(c.env.DB, { status }),
  ]);
  return json({ counts, subscribers: rows });
}

export async function get(c: RequestContext): Promise<Response> {
  const subscriber = await subscribers.getById(c.env.DB, param(c, "id"));
  if (!subscriber) throw notFound("subscriber");
  return json({ subscriber, suppressed: await subscribers.isSuppressed(c.env.DB, subscriber.email) });
}
