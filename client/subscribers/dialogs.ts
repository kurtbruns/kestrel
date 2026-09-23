// The subscriber actions taken from more than one surface: adding one (the list, the
// dashboard's quick actions) and unsubscribing one (the list's row menu, the dashboard).

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type { SubscribeResponse, Subscriber } from "../../shared/subscribers";
import { api } from "../api";
import { $ } from "../ui/dom";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";

/** Add subscriber → the normal double opt-in (never an auto-confirm). */
export function addSubscriberModal(onDone?: () => void): void {
  const m = modal(
    html`<h3>Add subscriber</h3><p class="hint">Starts the normal double opt-in: they get a confirmation email and won't receive posts until they confirm.</p><label for="addEmail">Email address</label><input type="email" id="addEmail" placeholder="person@example.com"><div class="actions"><button type="button" id="aCancel">Cancel</button><button type="button" class="primary" id="aGo">Send confirmation</button></div>`,
  );
  const input = $<HTMLInputElement>("#addEmail", m.el);
  const go = $<HTMLButtonElement>("#aGo", m.el);
  input.focus();
  $("#aCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Adding…", async () => {
      const addr = normalizeEmail(input.value);
      if (!isValidEmail(addr)) {
        toast("Enter a valid email");
        return;
      }
      try {
        const r = await api<SubscribeResponse>("/subscribers", {
          method: "POST",
          json: { email: addr },
        });
        m.close();
        toast(
          r.action === "already_confirmed"
            ? `${addr} is already confirmed`
            : `Confirmation sent to ${addr}`,
        );
        onDone?.();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    });
}

export function confirmUnsubscribe(sub: Subscriber, onDone: () => void): void {
  const m = modal(
    html`<h3>Unsubscribe this subscriber?</h3><p class="hint">Removes <strong>${sub.email}</strong> from the send audience immediately. They can re-subscribe later through the double opt-in.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`,
  );
  const go = $<HTMLButtonElement>("#uGo", m.el);
  $("#uCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Unsubscribing…", async () => {
      try {
        await api(`/subscribers/${sub.id}/unsubscribe`, { method: "POST" });
        m.close();
        toast(`Unsubscribed ${sub.email}`);
        onDone();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    });
}
