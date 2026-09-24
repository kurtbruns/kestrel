// The send actions a publisher takes from more than one surface: resolving a wedged send
// (the list, the watch) and rescheduling (the list's scheduled card, the editor's banner).

import type { ResolveResponse, SendSummary, StuckResolution } from "../../shared/sends";
import { api } from "../api";
import { earliestFireAt, minLeadText } from "../deployment";
import { $ } from "../ui/dom";
import { toLocalInput } from "../ui/format";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The one manual step for a wedged send: decide whether the ambiguous batch went out or
 * not. Both outcomes are safe for I4 (neither re-mails this post), so the modal explains
 * the trade-off (record accuracy) rather than warning of a double-send.
 */
export function openResolveModal(
  send: Pick<SendSummary, "id" | "c_in_flight">,
  reload: () => void,
): void {
  const n = send.c_in_flight || 0;
  const noun = n === 1 ? "delivery" : "deliveries";
  const m = modal(
    html`<h3>Resolve ${n} ambiguous ${noun}</h3>
      <p class="hint">A transport error left ${n} recipient${n === 1 ? "" : "s"} in flight: the request went out but the provider never confirmed, so we can't know if it was accepted. To avoid mailing anyone twice, the send won't retry ${n === 1 ? "it" : "them"} on its own — so it can't finish until you decide. Neither choice re-sends this post.</p>
      <p class="hint"><strong>Assume not sent</strong> — recorded as unsent; ${n === 1 ? "the address is" : "the addresses are"} simply picked up by your next post.</p>
      <p class="hint"><strong>Assume sent</strong> — recorded as delivered. Choose this only if you've confirmed it in your provider's console.</p>
      <div class="actions"><button type="button" id="rCancel">Cancel</button><button type="button" id="rUnsent">Assume not sent</button><button type="button" class="primary" id="rAccepted">Assume sent</button></div>`,
  );
  $("#rCancel", m.el).onclick = m.close;
  const doResolve = (btn: HTMLButtonElement, resolution: StuckResolution, verb: string) =>
    busy(btn, "Resolving…", async () => {
      try {
        const res = await api<ResolveResponse>(`/sends/${send.id}/resolve`, {
          method: "POST",
          json: { resolution },
        });
        m.close();
        toast(res.completed ? "Send completed" : `Marked ${verb}`);
        reload();
      } catch (e) {
        toast(message(e));
      }
    });
  const unsent = $<HTMLButtonElement>("#rUnsent", m.el);
  const accepted = $<HTMLButtonElement>("#rAccepted", m.el);
  unsent.onclick = () => doResolve(unsent, "unsent", "not sent");
  accepted.onclick = () => doResolve(accepted, "accepted", "sent");
}

/**
 * Move a scheduled send's fire time without canceling or re-editing: the content stays
 * frozen (I3) and the cancelable review window is preserved (I6); only fire_at moves,
 * via POST /sends/:id/reschedule (SPEC §6). The same datetime picker as the Schedule
 * modal, prefilled with the current fire time and floored at the minimum lead. Shared
 * by the editor's scheduled banner and the Sent page's scheduled card (SPEC §8), so
 * `onDone` re-renders whichever surface opened it.
 */
export function openRescheduleModal(
  sendId: string,
  currentFireAt: number,
  onDone: () => void,
): void {
  const minStr = toLocalInput(earliestFireAt());
  const cur = toLocalInput(new Date(currentFireAt));
  const m = modal(
    html`<h3 id="rsHead">Reschedule this post</h3>
      <p class="hint">Move when it sends (at least ${minLeadText()} out). The content stays frozen and the cancelable window is kept — only the time changes.</p>
      <label for="rsWhen">Send at</label><input type="datetime-local" id="rsWhen" min="${minStr}" value="${cur}">
      <div class="actions"><button type="button" id="rsCancel">Cancel</button><button type="button" class="primary" id="rsGo">Reschedule</button></div>`,
  );
  const box = $(".modal", m.el);
  box.setAttribute("aria-labelledby", "rsHead");
  const go = $<HTMLButtonElement>("#rsGo", box);
  const when = $<HTMLInputElement>("#rsWhen", box);
  $("#rsCancel", box).onclick = m.close;
  go.onclick = () =>
    busy(go, "Rescheduling…", async () => {
      const v = when.value;
      const t = v ? new Date(v).getTime() : Number.NaN;
      if (Number.isNaN(t)) {
        toast("Pick a valid date & time");
        return;
      }
      try {
        await api(`/sends/${sendId}/reschedule`, {
          method: "POST",
          json: { fire_at: new Date(t).toISOString() },
        });
        m.close();
        toast("Rescheduled");
        onDone();
      } catch (e) {
        toast(message(e));
      }
    });
  when.focus();
}
