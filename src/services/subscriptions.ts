/** Shared subscribe orchestration: create/re-arm a subscriber and send the
 *  double opt-in confirmation through the provider seam. Used by both the public
 *  form and the authed API. */

import type { Sender } from "../../shared/publication";
import * as notifications from "../db/notifications";
import { getSettings, resolveConfirmationEmail } from "../db/settings";
import * as subscribers from "../db/subscribers";
import { confirmationEmail } from "../emails/system";
import { confirmBrowserHash } from "../lib/confirm_browser";
import { newToken } from "../lib/ids";
import { errorText, log } from "../lib/log";
import { CONFIRM_COOLDOWN_MS, CONFIRM_LINK_TTL_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";
import { getProvider, requireConnectedProvider } from "../providers";
import type { HaltCause, RenderedEmail, SendBatchResult } from "../providers/types";
import { resolveBranding } from "../render/template_engine";
import type { RequestContext } from "../router";
import { senderFrom } from "../services/sender";
import { contactOutcome, noteContact } from "./sending";

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
  | { kind: "failed"; delivered: "no" | "unknown"; error: string; cause?: HaltCause };

/**
 * Subscribe `email` through double opt-in, sending it a confirmation if one is due. Never
 * confirms anyone (I1). Refused outright while no provider is connected (SPEC §13), before
 * anything is stored: an address whose confirmation cannot go would only sit pending. A confirmation the provider refuses changes nothing: a new address
 * leaves no row, and an existing one keeps the last link that did arrive. One whose fate is
 * unknown (no answer, or a halt after which it may have gone) is treated as sent, so its
 * link works if it arrived and the cooldown still holds.
 */
export async function requestSubscription(
  c: RequestContext,
  email: string,
  /** Whether a reader asked through the public form, where nobody sees a refusal as it
   *  happens, so the publisher is told by email that email isn't going out (SPEC §8). */
  fromReader = false,
  /** The cookie value the public form gave the browser that asked (SPEC §7): the link that
   *  goes out confirms at once when opened there. None for the publisher's Add. */
  browserValue: string | null = null,
): Promise<SubscriptionOutcome> {
  requireConnectedProvider(c.config);
  const db = c.env.DB;
  const existing = await subscribers.getByEmail(db, email);
  if (existing?.status === "confirmed") {
    return { kind: "skipped", subscriber: existing, action: "already_confirmed" };
  }
  if (await subscribers.isSuppressed(db, email)) {
    return { kind: "skipped", subscriber: existing, action: "suppressed" };
  }
  // Everything that can fail before the provider is asked happens before the claim, so
  // such a failure changes nothing and is never mistaken for a send.
  const token = newToken();
  const browserHash = browserValue ? await confirmBrowserHash(browserValue) : null;
  const { message, sender } = await confirmationMessage(c, token);
  const { subscriber, created } = await subscribers.ensureSubscriber(db, email);
  const now = Date.now();
  if (!(await subscribers.claimConfirmation(db, subscriber.id, now, now - CONFIRM_COOLDOWN_MS))) {
    // Already confirmed by a racing request, or a confirmation went out moments ago. The link
    // that went out is bound to this browser instead, so a reader who submits again while
    // waiting for the email still confirms in one click (SPEC §7). Never for the publisher's
    // Add, which binds no browser and leaves the reader's binding alone.
    if (browserHash) {
      await subscribers.rebindConfirmation(db, subscriber.id, browserHash);
    }
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

  const sent = await sendConfirmation(c, message, sender, subscriber, now, fromReader);
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
    log.warn("subscribe.confirmation_refused", { provider: c.config.provider, error: sent.error });
    if (sent.cause === "sandbox") {
      // The reader is told a link is on its way, so the publisher is the one who has to
      // hear that none went (SPEC §7, §8): at most once a day.
      // Telling is downstream of the signup: a failure to record it never changes the answer.
      try {
        await notifications.sandboxNotice(db, now);
      } catch (err) {
        log.error("subscribe.failed", { provider: c.config.provider, error: errorText(err) });
      }
    }
    return { kind: "failed", delivered: "no", error: sent.error, cause: sent.cause };
  }
  // Sent, or it may have been: arm its link so it works if it arrived, and keep the claim,
  // so a retry can't turn an outage into a flood.
  // The browser that asked for this link is armed with it, in the same statement as its token.
  const armed = await subscribers.armConfirmation(
    db,
    subscriber.id,
    token,
    now,
    subscriber.status,
    browserHash,
  );
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
    log.warn("subscribe.confirmation_unknown", { provider: c.config.provider, error: sent.error });
    return { kind: "failed", delivered: "unknown", error: sent.error };
  }
  return {
    kind: "sent",
    subscriber: unwrap(await subscribers.getById(db, subscriber.id), "subscriber"),
    action,
  };
}

/** The confirmation email carrying `token`, in the publisher's wording and identity, and
 *  the sender it goes out as (SPEC §9), both from one read of the settings. */
async function confirmationMessage(
  c: RequestContext,
  token: string,
): Promise<{ message: RenderedEmail; sender: Sender }> {
  const settings = await getSettings(c.env.DB);
  const copy = resolveConfirmationEmail(settings);
  // The branded layout reuses the same publication identity the post render does, so the
  // two never drift.
  const branding = resolveBranding(settings, c.config);
  const identity = { name: branding.name, tagline: branding.tagline, logoUrl: branding.logoUrl };
  return {
    message: confirmationEmail(`${c.config.appOrigin}/confirm?token=${token}`, copy, identity),
    sender: senderFrom(settings, c.config),
  };
}

/** Hand one confirmation to the provider and say whether it went: `yes`, `no` (refused,
 *  nothing sent), or `unknown` (no answer). What the answer says about the account is
 *  recorded (SPEC §13). */
async function sendConfirmation(
  c: RequestContext,
  message: RenderedEmail,
  sender: Sender,
  subscriber: subscribers.SubscriberRow,
  attemptAt: number,
  fromReader: boolean,
): Promise<
  | { delivered: "yes" }
  | { delivered: "no"; error: string; cause?: HaltCause }
  | { delivered: "unknown"; error: string }
> {
  const provider = getProvider(c.config, c.env, sender);
  const recipients = [{ email: subscriber.email, unsubscribeUrl: "" }];
  let result: SendBatchResult;
  try {
    result = await provider.sendBatch(message, recipients, {
      // One tag per confirmation sent, never reused: the fake records once per tag and
      // address, and would otherwise fold a deliberate resend into the first.
      purpose: "confirmation",
      tag: `confirm-${subscriber.id}-${attemptAt}`,
    });
  } catch (err) {
    return { delivered: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
  await noteContact(
    c.env.DB,
    c.config,
    "confirmation",
    contactOutcome(result),
    Date.now(),
    fromReader,
  );
  if (result.kind === "halted") {
    return { delivered: "no", error: result.halt.error, cause: result.halt.cause };
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

/** Whether a browser holding the cookie value `browserValue` asked for this subscriber's
 *  current link (SPEC §7): only then is opening the link consent. */
export async function isAskingBrowser(
  row: subscribers.SubscriberRow,
  browserValue: string,
): Promise<boolean> {
  return (
    row.confirm_browser_hash !== null &&
    row.confirm_browser_hash === (await confirmBrowserHash(browserValue))
  );
}

/** Record consent for a confirm link, the owner's deliberate action (I1): the Confirm button
 *  pressed, or the link opened in the browser that asked for it (`via`), with the IP it came
 *  from as its evidence. Returns the link's state after: `confirmed` on success, else why it
 *  could not be. Logs the confirmation, never the address, once, when it lands. */
export async function confirmSubscription(
  db: D1Database,
  token: string,
  ip: string | null,
  via: subscribers.ConfirmVia,
): Promise<ConfirmLinkState> {
  const result = await subscribers.confirm(db, token, Date.now() - CONFIRM_LINK_TTL_MS, ip, via);
  if (result?.confirmedNow) {
    log.info("subscribe.confirmed", { via });
    return { kind: "confirmed", subscriber: result.subscriber };
  }
  return confirmLinkState(db, token);
}

function linkIsLive(row: subscribers.SubscriberRow): boolean {
  return row.confirm_sent_at !== null && row.confirm_sent_at > Date.now() - CONFIRM_LINK_TTL_MS;
}
