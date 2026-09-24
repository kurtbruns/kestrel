/** Shared subscribe orchestration: create/re-arm a subscriber and send the
 *  double opt-in confirmation through the provider seam. Used by both the public
 *  form and the authed API. */

import { getSettings, resolveConfirmationEmail } from "../db/settings";
import * as subscribers from "../db/subscribers";
import { confirmationEmail } from "../emails/system";
import { newToken } from "../lib/ids";
import { CONFIRM_COOLDOWN_MS, CONFIRM_LINK_TTL_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";
import { getProvider } from "../providers";
import type { RenderedEmail, SendBatchResult } from "../providers/types";
import { resolveBranding } from "../render/template_engine";
import type { RequestContext } from "../router";

/**
 * What a subscribe request came to. `sent`: the provider took the confirmation. `skipped`:
 * none was due (already confirmed, suppressed, or one went out inside the cooldown).
 * `failed`: one was due and did not go, either refused, or with no answer at all
 * (`delivered: "unknown"`, when it may have arrived). Which of these happened is list
 * membership, so only the admin API reports it; the public form runs this after it has
 * answered (SPEC §7).
 */
export type SubscriptionOutcome =
  | { kind: "sent"; subscriber: subscribers.SubscriberRow; action: subscribers.SubscribeAction }
  | {
      kind: "skipped";
      subscriber: subscribers.SubscriberRow | null;
      action: subscribers.SubscribeAction;
    }
  | { kind: "failed"; delivered: "no" | "unknown"; error: string };

/**
 * Subscribe `email` through double opt-in, sending it a confirmation if one is due. Never
 * confirms anyone (I1). A confirmation the provider refuses changes nothing: a new address
 * leaves no row, and an existing one keeps the last link that did arrive. One whose fate is
 * unknown (no answer, or a halt after which it may have gone) is treated as sent, so its
 * link works if it arrived and the cooldown still holds.
 */
export async function requestSubscription(
  c: RequestContext,
  email: string,
): Promise<SubscriptionOutcome> {
  const db = c.env.DB;
  const existing = await subscribers.getByEmail(db, email);
  if (existing?.status === "confirmed") {
    return { kind: "skipped", subscriber: existing, action: "already_confirmed" };
  }
  if (await subscribers.blocksConfirmation(db, email)) {
    return { kind: "skipped", subscriber: existing, action: "suppressed" };
  }
  // Everything that can fail before the provider is asked happens before the claim, so
  // such a failure changes nothing and is never mistaken for a send.
  const token = newToken();
  const message = await confirmationMessage(c, token);
  const { subscriber, created } = await subscribers.ensureSubscriber(db, email);
  const now = Date.now();
  if (!(await subscribers.claimConfirmation(db, subscriber.id, now, now - CONFIRM_COOLDOWN_MS))) {
    // Already confirmed by a racing request, or a confirmation went out moments ago.
    const current = await subscribers.getById(db, subscriber.id);
    return {
      kind: "skipped",
      subscriber: current,
      action: current?.status === "confirmed" ? "already_confirmed" : "recently_sent",
    };
  }
  const action: subscribers.SubscribeAction = created
    ? "created"
    : subscriber.status === "unsubscribed"
      ? "resubscribed"
      : "pending_resent";

  const sent = await sendConfirmation(c, message, subscriber, now);
  if (sent.delivered === "no") {
    // Nothing went out, so nothing changes: the claim is released (a refusal is not a
    // send, and the reader may try again at once), and a row made for this request goes.
    await subscribers.releaseConfirmation(
      db,
      subscriber.id,
      now,
      subscriber.confirm_attempt_at,
      created,
    );
    console.error("confirmation email refused by the provider", sent.error);
    return { kind: "failed", delivered: "no", error: sent.error };
  }
  // Sent, or it may have been: arm its link so it works if it arrived, and keep the claim,
  // so a retry can't turn an outage into a flood.
  const armed = await subscribers.armConfirmation(db, subscriber.id, token, now, subscriber.status);
  if (!armed) {
    // The subscriber confirmed or unsubscribed while this was being sent; that stands, so
    // the link just sent is not armed and does nothing.
    const current = await subscribers.getById(db, subscriber.id);
    return {
      kind: "skipped",
      subscriber: current,
      action: current?.status === "confirmed" ? "already_confirmed" : "recently_sent",
    };
  }
  if (sent.delivered === "unknown") {
    console.error("confirmation email: fate unknown", sent.error);
    return { kind: "failed", delivered: "unknown", error: sent.error };
  }
  return {
    kind: "sent",
    subscriber: unwrap(await subscribers.getById(db, subscriber.id), "subscriber"),
    action,
  };
}

/** The confirmation email carrying `token`, in the publisher's wording and identity. */
async function confirmationMessage(c: RequestContext, token: string): Promise<RenderedEmail> {
  const settings = await getSettings(c.env.DB);
  const copy = resolveConfirmationEmail(settings);
  // The branded layout reuses the same publication identity the post render does
  // (name falls back to the From display name), so the two never drift.
  const branding = resolveBranding(settings, c.config);
  const identity = { name: branding.name, tagline: branding.tagline, logoUrl: branding.logoUrl };
  return confirmationEmail(`${c.config.appOrigin}/confirm?token=${token}`, copy, identity);
}

/** Hand one confirmation to the provider and say whether it went: `yes`, `no` (refused,
 *  nothing sent), or `unknown` (no answer, or a halt after which it may have gone). */
async function sendConfirmation(
  c: RequestContext,
  message: RenderedEmail,
  subscriber: subscribers.SubscriberRow,
  attemptAt: number,
): Promise<{ delivered: "yes" } | { delivered: "no" | "unknown"; error: string }> {
  const provider = getProvider(c.config, c.env);
  const recipients = [{ email: subscriber.email, unsubscribeUrl: "" }];
  let result: SendBatchResult;
  try {
    result = await provider.sendBatch(message, recipients, {
      // One key per confirmation sent, never reused: a provider that dedupes by key
      // would otherwise swallow a deliberate resend as a repeat of the first.
      purpose: "confirmation",
      idempotencyKeyPrefix: `confirm-${subscriber.id}-${attemptAt}`,
    });
  } catch (err) {
    return { delivered: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
  if (result.kind === "halted") {
    return { delivered: result.halt.mayHaveSent ? "unknown" : "no", error: result.halt.error };
  }
  const [answer] = result.results;
  if (!answer) {
    return { delivered: "unknown", error: "the provider gave no answer for the recipient" };
  }
  return answer.accepted ? { delivered: "yes" } : { delivered: "no", error: answer.error };
}

/** Where a confirm link stands: good to confirm, confirmed already, too old, or not one. */
export type ConfirmLinkState =
  | { kind: "ready"; subscriber: subscribers.SubscriberRow }
  | { kind: "confirmed"; subscriber: subscribers.SubscriberRow }
  | { kind: "expired"; subscriber: subscribers.SubscriberRow }
  | { kind: "invalid" };

/** Read a confirm link's state without changing anything: opening the link is not consent,
 *  since mail scanners open every link (SPEC §7). */
export async function confirmLinkState(db: D1Database, token: string): Promise<ConfirmLinkState> {
  const row = token ? await subscribers.getByConfirmToken(db, token) : null;
  if (!row || row.status === "unsubscribed") {
    return { kind: "invalid" };
  }
  if (row.status === "confirmed") {
    return { kind: "confirmed", subscriber: row };
  }
  return linkIsLive(row)
    ? { kind: "ready", subscriber: row }
    : { kind: "expired", subscriber: row };
}

/** Record consent for a confirm link, the owner's deliberate action (I1). Returns the
 *  link's state after: `confirmed` on success, else why it could not be. */
export async function confirmSubscription(
  db: D1Database,
  token: string,
): Promise<ConfirmLinkState> {
  const row = token ? await subscribers.confirm(db, token, Date.now() - CONFIRM_LINK_TTL_MS) : null;
  if (row?.status === "confirmed") {
    return { kind: "confirmed", subscriber: row };
  }
  return confirmLinkState(db, token);
}

function linkIsLive(row: subscribers.SubscriberRow): boolean {
  return row.confirm_sent_at !== null && row.confirm_sent_at > Date.now() - CONFIRM_LINK_TTL_MS;
}
