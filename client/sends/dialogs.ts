// The send actions a publisher takes from more than one surface: resolving a wedged send
// (the list, the watch) and rescheduling, the Schedule dialog for a scheduled post (the list's
// scheduled card, the editor's banner).

import type { PostResponse } from "../../shared/posts";
import type { ResolveResponse, SendSummary, StuckResolution } from "../../shared/sends";
import { ApiError, api, describeError } from "../api";
import { earliestFireAt, isTooSoon, notConnectedRescheduleLine, tooSoonText } from "../deployment";
import {
  mountSettingsForm,
  type Publishing,
  publishingOf,
  settingsChange,
  showSlugRefusal,
} from "../posts/publishing";
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
 * Edit a scheduled send's schedule: the Schedule dialog again, for a post already scheduled, with
 * its time and, under it, the post's settings. Save applies whatever changed, through one
 * reschedule (SPEC §6): a moved time moves the send without canceling or re-editing (the content
 * stays frozen, I3, and the cancelable window is kept, I6), and the time it already has stays,
 * so a change to the settings alone is saved as it is. Cancel leaves both as they were. Shared by
 * the editor's scheduled banner and the Sent page's scheduled card (SPEC §8), so `onDone`
 * re-renders whichever surface opened it. The banner passes the post's settings it holds; the
 * card has only the send, so the dialog reads the post first.
 */
export async function openRescheduleModal(
  send: { id: string; post_id: string; fire_at: number },
  onDone: () => void,
  signal: AbortSignal,
  known?: Publishing,
): Promise<void> {
  let saved = known;
  if (!saved) {
    try {
      const read = await api<PostResponse>(`/api/posts/${send.post_id}`, { signal });
      saved = publishingOf(read.post, read.slug_taken);
    } catch (e) {
      if (!signal.aborted) {
        toast(message(e));
      }
      return;
    }
  }
  const stored = saved;
  // The dialog's copy: Cancel leaves the post as it was.
  const working: Publishing = { ...stored };
  const minStr = toLocalInput(earliestFireAt());
  const cur = new Date(toLocalInput(new Date(send.fire_at)));

  const m = modal(
    html`<h3 id="rsHead">Edit schedule</h3>
      <p class="hint" id="rsHint">It sends at the time you pick, with a cancelable window until then.</p>
      ${notConnectedRescheduleLine()}
      <label for="rsWhen">Send at</label><input type="datetime-local" id="rsWhen" min="${minStr}" value="${toLocalInput(cur)}">
      <div class="dialog-settings" id="rsForm"></div>
      <div class="actions"><button type="button" id="rsCancel">Cancel</button><button type="button" class="primary" id="rsGo">Save</button></div>`,
    signal,
  );
  const box = $(".modal", m.el);
  box.setAttribute("aria-labelledby", "rsHead");
  mountSettingsForm($("#rsForm", box), working, "rs");
  const go = $<HTMLButtonElement>("#rsGo", box);
  const when = $<HTMLInputElement>("#rsWhen", box);
  $("#rsCancel", box).onclick = m.close;
  go.onclick = () =>
    busy(go, "Saving…", async () => {
      m.clearError();
      const v = when.value;
      const t = v ? new Date(v).getTime() : Number.NaN;
      if (Number.isNaN(t)) {
        m.error("Pick a valid date & time", when);
        return;
      }
      // The time it already has stays, however near: the server keeps it without a move, so a
      // reschedule that changes only the settings works up to the fire time (SPEC §6).
      const unchanged = t === cur.getTime();
      if (!unchanged && isTooSoon(t)) {
        m.error(tooSoonText(), when);
        return;
      }
      try {
        // The settings go with the move, checked before it and applied once it is accepted
        // (SPEC §6), so a refused move changes nothing.
        await api(`/api/sends/${send.id}/reschedule`, {
          method: "POST",
          json: {
            fire_at: new Date(t).toISOString(),
            email_only: working.emailOnly,
            ...settingsChange(stored, working),
          },
        });
        m.close();
        // Said after the act, so it can say exactly what changed.
        toast(unchanged ? "Saved" : "Rescheduled");
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
        if (!showSlugRefusal(box, "rs", e)) {
          m.error(message(e));
        }
      }
    });
  when.focus();
}
