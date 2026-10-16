/** Authed suppression admin (SPEC §7): list, the publisher's block, and clearing one.
 *  Webhooks add the provider's suppressions and an erasure adds its marker; a client adds
 *  only a block, and clearing is a deliberate, rare human action that never lifts an
 *  erasure's marker. */

import { normalizeEmail } from "../../shared/email";
import type {
  BlockResponse,
  ClearSuppressionResponse,
  SuppressionListResponse,
} from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { fieldError, optString, readJsonObject } from "../lib/body";
import { json, refusal } from "../lib/errors";
import { log } from "../lib/log";
import type { RequestContext } from "../router";
import { param } from "../router";

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

export async function clear(c: RequestContext): Promise<Response> {
  const email = normalizeEmail(param(c, "email"));
  const outcome = await subscribers.clearSuppression(c.env.DB, email);
  if (outcome === "erased") {
    throw refusal(
      "erasure_marker",
      "This address was erased. Only the person’s own confirmation lifts its do-not-contact marker.",
    );
  }
  const body: ClearSuppressionResponse = { email, cleared: outcome === "cleared" };
  return json(body);
}
