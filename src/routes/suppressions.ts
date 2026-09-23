/** Authed suppression admin: list, add (manual), clear. Webhooks add automatic
 *  suppressions in M9/M10; clearing is a deliberate, rare human action. */

import * as subscribers from "../db/subscribers";
import { normalizeEmail } from "../db/subscribers";
import { fieldError, optString, readJsonObject } from "../lib/body";
import { json } from "../lib/errors";
import type { RequestContext } from "../router";
import { param } from "../router";

export async function list(c: RequestContext): Promise<Response> {
  return json({ suppressions: await subscribers.listSuppressions(c.env.DB) });
}

export async function add(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const email = normalizeEmail(optString(body, "email") ?? "");
  if (!email) {
    throw fieldError("email", "email is required");
  }
  const reason = optString(body, "reason") ?? "manual";
  const detail = optString(body, "detail");
  await subscribers.addSuppression(c.env.DB, email, reason, detail);
  return json({ suppressed: email, reason }, 201);
}

export async function clear(c: RequestContext): Promise<Response> {
  const email = normalizeEmail(param(c, "email"));
  const cleared = await subscribers.clearSuppression(c.env.DB, email);
  return json({ email, cleared });
}
