// The subscriber dialogs: adding one (the list, the dashboard's quick actions), and
// unsubscribing, blocking, unblocking, clearing, or erasing one (a row's menu, their page).

import { isValidEmail, normalizeEmail } from "../../shared/email";
import { SUPPRESSION_FLAG } from "../../shared/subscriber_meanings";
import type {
  BlockResponse,
  EraseResponse,
  LiftSuppressionResponse,
  SubscribeAction,
  SubscribeResponse,
  Subscriber,
} from "../../shared/subscribers";
import { ApiError, api, describeError } from "../api";
import { notConnectedAddLine, providerNotConnected } from "../deployment";
import { $ } from "../ui/dom";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";

/**
 * Add subscriber → the normal double opt-in (never an auto-confirm). While no provider is
 * connected the confirmation can't go and the server would refuse, so the dialog says so
 * before the publisher types anything: the standing line, no address field, its act
 * disabled (DESIGN §4).
 */
export function addSubscriberModal(onDone: () => void, signal: AbortSignal): void {
  const notConnected = providerNotConnected();
  const m = modal(
    html`<h3>Add subscriber</h3><p class="hint">Starts the normal double opt-in: they get a confirmation email and won’t receive posts until they confirm.</p>${notConnectedAddLine()}${notConnected ? null : html`<label for="addEmail">Email address</label><input type="email" id="addEmail" placeholder="person@example.com">`}<div class="actions"><button type="button" id="aCancel">Cancel</button><button type="button" class="primary" id="aGo">Send confirmation</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#aGo", m.el);
  $("#aCancel", m.el).onclick = m.close;
  go.disabled = notConnected;
  if (notConnected) {
    $("#aCancel", m.el).focus();
    return;
  }
  const input = $<HTMLInputElement>("#addEmail", m.el);
  input.focus();
  go.onclick = () =>
    busy(go, "Adding…", async () => {
      m.clearError();
      const addr = normalizeEmail(input.value);
      if (!isValidEmail(addr)) {
        m.error("Enter a valid email address", input);
        return;
      }
      try {
        // Someone who left by a complaint or an erasure is refused (`signup_required`), and
        // the refusal's message, shown as it stands, says to have them subscribe themselves.
        const r = await api<SubscribeResponse>("/api/subscribers", {
          method: "POST",
          json: { email: addr },
        });
        m.close();
        toast(addedMessage(addr, r.action));
        onDone();
      } catch (e) {
        // A refusal about the address goes under it; anything else, above the buttons.
        m.error(describeError(e), e instanceof ApiError && e.field === "email" ? input : undefined);
      }
    });
}

/** What the Add told the admin: a confirmation went, or why none was due. A refused
 *  confirmation is an API error, shown by the caller as it is. */
function addedMessage(addr: string, action: SubscribeAction): string {
  switch (action) {
    case "already_confirmed":
      return `${addr} is already confirmed`;
    case "suppressed":
      return `${addr} is suppressed, so no confirmation was sent`;
    case "recently_sent":
      return `A confirmation went to ${addr} a few minutes ago; try again later`;
    default:
      return `Confirmation sent to ${addr}`;
  }
}

export function confirmUnsubscribe(sub: Subscriber, onDone: () => void, signal: AbortSignal): void {
  const m = modal(
    html`<h3>Unsubscribe this subscriber?</h3><p class="hint">Use this when <strong>${sub.email}</strong> asks you to take them off the list. They stop receiving posts immediately, and can rejoin by subscribing again. To stop mailing them on your own judgment, block the address instead.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#uGo", m.el);
  $("#uCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Unsubscribing…", async () => {
      m.clearError();
      try {
        await api(`/api/subscribers/${sub.id}/unsubscribe`, { method: "POST" });
        m.close();
        toast(`Unsubscribed ${sub.email}`);
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

/**
 * Block is the publisher's own decision to stop mailing an address (SPEC §7), so its dialog
 * says so and points a reader's own request to Unsubscribe instead. It keeps their status
 * and can be undone, so it confirms without the weight of Erase.
 */
export function confirmBlock(sub: Subscriber, onDone: () => void, signal: AbortSignal): void {
  const m = modal(
    html`<h3>Block this address?</h3><p class="hint">Stops all mail to <strong>${sub.email}</strong>, whatever their status, which stays as it is. Use this when you decide yourself to stop mailing them; if they asked to leave, unsubscribe them instead. You can unblock it later.</p><div class="actions"><button type="button" id="bCancel">Cancel</button><button type="button" class="danger" id="bGo">Block</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#bGo", m.el);
  $("#bCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Blocking…", async () => {
      m.clearError();
      try {
        const r = await api<BlockResponse>("/api/suppressions", {
          method: "POST",
          json: { email: sub.email },
        });
        m.close();
        // Something else may have suppressed it since the list was read: say what stands.
        toast(
          r.added
            ? `Blocked ${sub.email}`
            : `${sub.email} was already suppressed (${SUPPRESSION_FLAG[r.suppression.reason]})`,
        );
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

/** Unblock undoes the publisher's own block, and only that: the dialog says what follows. */
export function confirmUnblock(sub: Subscriber, onDone: () => void, signal: AbortSignal): void {
  const mailed =
    sub.status === "confirmed"
      ? "They’re confirmed, so they’ll receive your posts again."
      : "They’ll receive posts again only once they’re confirmed.";
  const m = modal(
    html`<h3>Unblock this address?</h3><p class="hint">Undoes the block on <strong>${sub.email}</strong>. ${mailed}</p><div class="actions"><button type="button" id="ubCancel">Cancel</button><button type="button" class="primary" id="ubGo">Unblock</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#ubGo", m.el);
  $("#ubCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Unblocking…", async () => {
      m.clearError();
      try {
        await liftSuppression(sub);
        m.close();
        toast(`Unblocked ${sub.email}`);
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

/** Lift the subscriber's suppression, naming the reason the row showed, so a reason that
 *  changed since is refused rather than lifted (SPEC §7). */
function liftSuppression(sub: Subscriber): Promise<LiftSuppressionResponse> {
  return api<LiftSuppressionResponse>("/api/suppressions/lift", {
    method: "POST",
    json: { email: sub.email, reason: sub.suppression?.reason },
  });
}

/**
 * Clear lifts a bounce, which records someone else's verdict on the address (the provider's,
 * or the previous service's), so it is the riskier way back to mailing it: the dialog says
 * the address failed, and a bounce is cleared once the publisher knows its cause is gone
 * (SPEC §7).
 */
export function confirmClear(sub: Subscriber, onDone: () => void, signal: AbortSignal): void {
  const mailed =
    sub.status === "confirmed"
      ? "They’re confirmed, so they’ll receive your posts again."
      : "They’ll receive posts again only once they’re confirmed.";
  const m = modal(
    html`<h3>Clear this bounce?</h3><p class="hint">Lets mail go again to <strong>${sub.email}</strong>, an address where mail failed. Clear it only when you know the reason is gone, such as a reader who tells you their mailbox is fixed. ${mailed}</p><div class="actions"><button type="button" id="cCancel">Cancel</button><button type="button" class="danger" id="cGo">Clear</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#cGo", m.el);
  $("#cCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Clearing…", async () => {
      m.clearError();
      try {
        await liftSuppression(sub);
        m.close();
        toast(`Cleared the bounce on ${sub.email}`);
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

/**
 * Erase removes the person's data for good (SPEC §7), so it is confirmed in a dialog that
 * says what goes, what stays, and that it can't be undone (DESIGN §7).
 */
export function confirmErase(sub: Subscriber, onDone: () => void, signal: AbortSignal): void {
  const m = modal(
    html`<h3>Erase this subscriber?</h3><p class="hint">Unsubscribes <strong>${sub.email}</strong> and deletes how they joined and the evidence for it, and past sends show an erased recipient in its place. Only the address is kept, so it’s never mailed again. This can’t be undone. They can still rejoin by subscribing and confirming themselves, but you can’t add them back.</p><div class="actions"><button type="button" id="eCancel">Cancel</button><button type="button" class="danger" id="eGo">Erase</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#eGo", m.el);
  $("#eCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Erasing…", async () => {
      m.clearError();
      try {
        const r = await api<EraseResponse>(`/api/subscribers/${sub.id}/erase`, { method: "POST" });
        m.close();
        toast(erasedMessage(r));
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

// What a suppression the erasure kept is called, for the toast.
const KEPT_SUPPRESSION: Record<string, string> = {
  bounce: "bounce",
  import_bounce: "bounce",
  manual: "block",
};

/** What the erasure left: the address alone, beside any bounce or block it had. */
function erasedMessage({ subscriber }: EraseResponse): string {
  const kept = subscriber.suppression;
  return kept
    ? `Erased ${subscriber.email}. Its ${KEPT_SUPPRESSION[kept.reason] ?? "suppression"} still stands`
    : `Erased ${subscriber.email}`;
}
