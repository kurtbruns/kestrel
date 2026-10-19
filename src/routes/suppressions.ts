/** Authed suppression admin (SPEC §7): list, the publisher's block, and lifting one.
 *  Webhooks add the provider's bounces; a client adds only a block, and lifts a block or a
 *  bounce, a deliberate, rare human action. */

import { normalizeEmail } from "../../shared/email";
import {
  type BlockResponse,
  type LiftSuppressionResponse,
  SUPPRESSION_REASONS,
  type Suppression,
  type SuppressionListResponse,
} from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { fieldError, oneOf, optString, readJsonObject } from "../lib/body";
import { json, refusal } from "../lib/errors";
import { log } from "../lib/log";
import type { RequestContext } from "../router";

export async function list(c: RequestContext): Promise<Response> {
  const body: SuppressionListResponse = {
    suppressions: await subscribers.listSuppressions(c.env.DB),
  };
  return json(body);
}

export async function add(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const email = normalizeEmail(optString(body, "email") ?? "");
  if (!email) {
    throw fieldError("email", "email is required");
  }
  // A client records only its own decision. A bounce is the provider's to report, so a
  // reason claiming one would misstate whose decision the suppression was.
  const reason = optString(body, "reason");
  if (reason !== undefined && reason !== "manual") {
    throw fieldError(
      "reason",
      "only a block (reason manual) can be added: a bounce comes from the provider",
    );
  }
  const detail = optString(body, "detail");
  const out: BlockResponse = await subscribers.block(c.env.DB, email, detail);
  if (out.added) {
    // Neither the address nor the detail, which is the publisher's own free text.
    log.info("suppression.added", { source: "manual", count: 1 });
  }
  return json(out, out.added ? 201 : 200);
}

/**
 * Lift a suppression on the publisher's word (SPEC §7): Unblock for a block, Clear for a
 * bounce. The client names the reason it saw, and a different one standing now is refused
 * with it, so a lift asked for a block never lifts a bounce that arrived since.
 */
export async function lift(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const email = normalizeEmail(optString(body, "email") ?? "");
  if (!email) {
    throw fieldError("email", "email is required");
  }
  const reason = oneOf(body, "reason", SUPPRESSION_REASONS);
  const db = c.env.DB;
  const standing = await subscribers.suppressionRow(db, email);
  if (standing === null) {
    const none: LiftSuppressionResponse = { email, lifted: false };
    return json(none);
  }
  if (standing.reason !== reason) {
    throw changed(standing);
  }
  if (!(await subscribers.liftSuppression(db, email, reason))) {
    // Lifted or replaced between the read and the lift: say what stands now.
    const now = await subscribers.suppressionRow(db, email);
    if (now !== null) {
      throw changed(now);
    }
    const gone: LiftSuppressionResponse = { email, lifted: false };
    return json(gone);
  }
  const lifted: LiftSuppressionResponse = { email, lifted: true };
  return json(lifted);
}

function changed(standing: Suppression) {
  return refusal(
    "suppression_changed",
    `This address’s suppression is now ${standing.reason}, not the one named. Read it again before deciding.`,
    { suppression: standing },
  );
}
