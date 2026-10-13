// The send actions a publisher takes from more than one surface: resolving a wedged send
// (the list, the watch) and rescheduling (the list's scheduled card, the editor's banner).

import type { ResolveResponse, SendSummary, StuckResolution } from "../../shared/sends";
import { ApiError, api, describeError } from "../api";
import { earliestFireAt, isTooSoon, notConnectedRescheduleLine, tooSoonText } from "../deployment";
import { readSendsNow } from "../send_state";
import { $ } from "../ui/dom";
import { toLocalInput } from "../ui/format";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";

const message = describeError;

/**
 * The one manual step for a wedged send: decide whether the ambiguous batch went out or
 * not. Both outcomes are safe for I4 (neither re-mails this post), so the modal explains
 * the trade-off (record accuracy) rather than warning of a double-send.
 */
export function openResolveModal(
  send: Pick<SendSummary, "id" | "c_in_flight">,
  reload: () => void,
  signal: AbortSignal,
): void {
  const n = send.c_in_flight || 0;
  const noun = n === 1 ? "delivery" : "deliveries";
  const m = modal(
    html`<h3>Resolve ${n} ambiguous ${noun}</h3>
      <p class="hint">A transport error left ${n} recipient${n === 1 ? "" : "s"} in flight: the request went out but the provider never confirmed, so there’s no way to know whether it was accepted. To avoid mailing anyone twice, the send won’t retry ${n === 1 ? "it" : "them"} on its own, so it can’t finish until you decide. Neither choice re-sends this post.</p>
      <p class="hint">Kestrel can’t tell whether ${n === 1 ? "this email" : "these emails"} went out, so unless you know, <strong>Assume not sent</strong> is the safe default.</p>
      <p class="hint"><strong>Assume not sent</strong>: recorded as unsent. ${n === 1 ? "That reader" : "Those readers"} may miss this post but ${n === 1 ? "gets" : "get"} your next one, and no one is mailed twice.</p>
      <p class="hint"><strong>Assume sent</strong>: recorded as accepted by your provider, with delivery still waiting on its receipt. Choose this when you know otherwise, such as a reader who says they got it.</p>
      <div class="actions"><button type="button" id="rCancel">Cancel</button><button type="button" id="rUnsent">Assume not sent</button><button type="button" class="primary" id="rAccepted">Assume sent</button></div>`,
    signal,
  );
  $("#rCancel", m.el).onclick = m.close;
  const doResolve = (btn: HTMLButtonElement, resolution: StuckResolution, verb: string) =>
    busy(btn, "Resolving…", async () => {
      m.clearError();
      try {
        const res = await api<ResolveResponse>(`/api/sends/${send.id}/resolve`, {
          method: "POST",
          json: { resolution },
        });
        m.close();
        toast(res.completed ? "Send completed" : `Marked ${verb}`);
        reload();
      } catch (e) {
        m.error(message(e));
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
 * via POST /api/sends/:id/reschedule (SPEC §6). The same datetime picker as the Schedule
 * modal, prefilled with the current fire time and floored at the minimum lead. Shared
 * by the editor's scheduled banner and the Sent page's scheduled card (SPEC §8), so
 * `onDone` re-renders whichever surface opened it.
 */
export function openRescheduleModal(
  sendId: string,
  currentFireAt: number,
  onDone: () => void,
  signal: AbortSignal,
): void {
  const minStr = toLocalInput(earliestFireAt());
  const cur = toLocalInput(new Date(currentFireAt));
  const m = modal(
    html`<h3 id="rsHead">Reschedule this post</h3>
      <p class="hint">Move when it sends. The content stays frozen and the cancelable window is kept. Only the time changes.</p>
      ${notConnectedRescheduleLine()}
      <label for="rsWhen">Send at</label><input type="datetime-local" id="rsWhen" min="${minStr}" value="${cur}">
      <div class="actions"><button type="button" id="rsCancel">Cancel</button><button type="button" class="primary" id="rsGo">Reschedule</button></div>`,
    signal,
  );
  const box = $(".modal", m.el);
  box.setAttribute("aria-labelledby", "rsHead");
  const go = $<HTMLButtonElement>("#rsGo", box);
  const when = $<HTMLInputElement>("#rsWhen", box);
  $("#rsCancel", box).onclick = m.close;
  go.onclick = () =>
    busy(go, "Rescheduling…", async () => {
      m.clearError();
      const v = when.value;
      const t = v ? new Date(v).getTime() : Number.NaN;
      if (Number.isNaN(t)) {
        m.error("Pick a valid date & time", when);
        return;
      }
      if (isTooSoon(t)) {
        m.error(tooSoonText(), when);
        return;
      }
      try {
        await api(`/api/sends/${sendId}/reschedule`, {
          method: "POST",
          json: { fire_at: new Date(t).toISOString() },
        });
        m.close();
        toast("Rescheduled");
        onDone();
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // The send went with its post. Say so in words (the API names only "send"), and
          // read the feed now so the page showing it follows: the editor goes to Drafts with
          // the same message, which shows as one toast.
          m.close();
          toast("This post was deleted elsewhere.");
          readSendsNow();
          return;
        }
        if (e instanceof ApiError && e.field === "fire_at") {
          m.error(message(e), when);
          return;
        }
        m.error(message(e));
      }
    });
  when.focus();
}
