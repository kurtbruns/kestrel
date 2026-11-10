// The send actions a publisher takes from more than one surface: resolving a wedged send
// (the list, the watch) and rescheduling, the Schedule dialog for a scheduled post (the list's
// scheduled card, the editor's banner).

import type { PostResponse } from "../../shared/posts";
import type { ResolveResponse, SendSummary, WedgedResolution } from "../../shared/sends";
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
  const doResolve = (btn: HTMLButtonElement, resolution: WedgedResolution, verb: string) =>
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
 * its time and, under it, the post's settings. Save applies whatever changed, each through its own
 * route: the settings through the post's (SPEC §5), then a moved time through a reschedule
 * (SPEC §6), which moves the send without canceling or re-editing (the content stays frozen, I3,
 * and the cancelable window is kept, I6). Cancel leaves both as they were. Shared by
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
      saved = publishingOf(read.post, read.subject_slug_held);
    } catch (e) {
      if (!signal.aborted) {
        toast(message(e));
      }
      return;
    }
  }
  // What the post holds: after a Save whose settings landed but whose time was refused, the
  // settings saved, so a second Save sends only what is still to change.
  let stored: Publishing = saved;
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
  // Settings saved by a Save whose time was then refused: closing shows them on the page.
  let savedSome = false;
  $("#rsCancel", box).onclick = () => {
    m.close();
    if (savedSome) {
      onDone();
    }
  };
  go.onclick = () =>
    busy(go, "Saving…", async () => {
      m.clearError();
      const v = when.value;
      const t = v ? new Date(v).getTime() : Number.NaN;
      if (Number.isNaN(t)) {
        m.error("Pick a valid date & time", when);
        return;
      }
      // The time it already has stays, however near: only a moved time is checked against the
      // lead, so a change to the settings alone saves up to the fire time (SPEC §6).
      const unchanged = t === cur.getTime();
      if (!unchanged && isTooSoon(t)) {
        m.error(tooSoonText(), when);
        return;
      }
      const change = settingsChange(stored, working);
      if (unchanged && !change) {
        m.close();
        return;
      }
      /** The send went with its post. Say so in words (the API names only "send" or "post"),
       *  and read the feed now so the page showing it follows: the editor goes to Drafts with
       *  the same message, which shows as one toast. */
      const deleted = (e: unknown) => {
        if (!(e instanceof ApiError && e.status === 404)) {
          return false;
        }
        m.close();
        toast("This post was deleted elsewhere.");
        readSendsNow();
        return true;
      };
      // Each part through its own route, the settings first (SPEC §5, §6): a refused address,
      // the likeliest failure, then stops the save before the time moves.
      if (change) {
        try {
          await api(`/api/posts/${send.post_id}/settings`, { method: "PUT", json: change });
        } catch (e) {
          if (!deleted(e) && !showSlugRefusal(box, "rs", e)) {
            m.error(message(e));
          }
          return;
        }
      }
      if (!unchanged) {
        try {
          await api(`/api/sends/${send.id}/reschedule`, {
            method: "POST",
            json: { fire_at: new Date(t).toISOString() },
          });
        } catch (e) {
          if (deleted(e)) {
            return;
          }
          const timeRefused = e instanceof ApiError && e.field === "fire_at";
          if (change) {
            // The settings are saved and stay so, since they may change in any state.
            stored = { ...working };
            savedSome = true;
            if (timeRefused) {
              // A time the publisher can fix, such as one the server's clock finds too soon:
              // keep the dialog, saying the settings landed, so only the time is left.
              m.error(`Settings saved. ${message(e)}`, when);
              return;
            }
            // The time can't move at all (the send has just fired): say so, and show both
            // surfaces as they now stand.
            m.close();
            toast(`Settings saved. The send time didn’t change: ${message(e)}`);
            onDone();
            return;
          }
          if (timeRefused) {
            m.error(message(e), when);
          } else {
            m.error(message(e));
          }
          return;
        }
      }
      m.close();
      // Said after the act, so it can say exactly what changed.
      toast(unchanged ? "Saved" : "Rescheduled");
      onDone();
    });
  when.focus();
}
