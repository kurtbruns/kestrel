/** Authed suppression admin: list, add (manual), clear. Webhooks add automatic
 *  suppressions in M9/M10; clearing is a deliberate, rare human action. */

import * as subscribers from "../db/subscribers";
import { normalizeEmail } from "../db/subscribers";
import { badRequest, json } from "../lib/errors";
import type { RequestContext } from "../router";
import { param } from "../router";

export async function list(c: RequestContext): Promise<Response> {
  return json({ suppressions: await subscribers.listSuppressions(c.env.DB) });
}

export async function add(c: RequestContext): Promise<Response> {
  let body: { email?: unknown; reason?: unknown; detail?: unknown };
  try {
    body = (await c.req.json()) as { email?: unknown; reason?: unknown; detail?: unknown };
  } catch {
    throw badRequest("JSON body with an 'email' is required");
  }
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email) {
    throw badRequest("email is required");
  }
  const reason = typeof body.reason === "string" ? body.reason : "manual";
  const detail = typeof body.detail === "string" ? body.detail : undefined;
  await subscribers.addSuppression(c.env.DB, email, reason, detail);
  return json({ suppressed: email, reason }, 201);
}

export async function clear(c: RequestContext): Promise<Response> {
  const email = normalizeEmail(param(c, "email"));
  const cleared = await subscribers.clearSuppression(c.env.DB, email);
  return json({ email, cleared });
}
