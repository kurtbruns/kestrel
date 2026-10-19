/** Authed suppression admin (SPEC §7): list, the publisher's block, and lifting one.
 *  Webhooks add the provider's suppressions and an erasure adds its marker; a client adds
 *  only a block, and lifts only a block or a bounce, a deliberate, rare human action that
 *  never lifts an erasure's marker. */

import { normalizeEmail } from "../../shared/email";
import {
  type BlockResponse,
  type LiftSuppressionResponse,
  PUBLISHER_LIFTS,
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
  // A client records only its own decision. A bounce or complaint is the provider's to
  // report and an erasure's marker is Erase's to leave, so a reason claiming either would
  // misstate whose decision the suppression was.
  const reason = optString(body, "reason");
  if (reason !== undefined && reason !== "manual") {
    throw fieldError(
      "reason",
      "only a block (reason manual) can be added: bounces and complaints come from the provider, and an erasure from Erase",
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
 * Lift a suppression on the publisher's word (SPEC §7): Unblock for their own block, Clear for
 * a bounce. The client names the reason it saw, and a different one standing now is refused
 * with it, so a lift asked for a bounce never lifts another reason that arrived since. Any
 * other reason isn't lifted here.
 */
export async function lift(c: RequestContext): Promise<Response> {
  const body = await readJsonObject(c);
  const email = normalizeEmail(optString(body, "email") ?? "");
  if (!email) {
    throw fieldError("email", "email is required");
  }
  const reason = oneOf(body, "reason", SUPPRESSION_REASONS);
  if (reason !== subscribers.ERASED && !PUBLISHER_LIFTS.includes(reason)) {
    throw fieldError(
      "reason",
      "only a block (manual) or a bounce (bounce, import_bounce) is lifted here",
    );
  }
  const db = c.env.DB;
  const standing = await subscribers.suppressionRow(db, email);
  if (standing === null) {
    const none: LiftSuppressionResponse = { email, lifted: false };
    return json(none);
  }
  if (standing.reason !== reason) {
    throw changed(standing);
  }
  if (reason === subscribers.ERASED) {
    throw refusal(
      "erasure_marker",
      "This address was erased. Only the person’s own confirmation lifts its do-not-contact marker.",
      { suppression: standing },
    );
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
