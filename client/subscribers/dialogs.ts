// The subscriber actions taken from more than one surface: adding one (the list, the
// dashboard's quick actions) and unsubscribing one (the list's row menu, the dashboard).

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type { SubscribeAction, SubscribeResponse, Subscriber } from "../../shared/subscribers";
import { api } from "../api";
import { notConnectedAddLine, providerNotConnected } from "../deployment";
import { $ } from "../ui/dom";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";

/**
 * Add subscriber → the normal double opt-in (never an auto-confirm). While no provider is
 * connected the confirmation can't go and the server would refuse, so the dialog says so
 * before the publisher types anything: the standing line, no address field, its act
 * disabled (DESIGN §2).
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
        const r = await api<SubscribeResponse>("/api/subscribers", {
          method: "POST",
          json: { email: addr },
        });
        m.close();
        toast(addedMessage(addr, r.action));
        onDone();
      } catch (e) {
        m.error(e instanceof Error ? e.message : String(e));
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
    html`<h3>Unsubscribe this subscriber?</h3><p class="hint">Removes <strong>${sub.email}</strong> from the send audience immediately. They can re-subscribe later through the double opt-in.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`,
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
        m.error(e instanceof Error ? e.message : String(e));
      }
    });
}
