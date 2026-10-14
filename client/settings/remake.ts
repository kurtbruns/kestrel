// The re-make confirmation (SPEC §6, §9; DESIGN §4): the in-use chip and the
// confirm-then-save flow the Template and Settings pages share.

import type { InUseView, RemakeRequiredError, ScheduledSendRef } from "../../shared/settings";
import { ApiError } from "../api";
import { at } from "../lifecycle";
import { fmt } from "../ui/format";
import { type Html, html } from "../ui/html";
import { icon } from "../ui/icons";
import { modal, toast } from "../ui/widgets";

/** The words a re-make confirmation uses for the commit: { action: "Save", gerund: "Saving", lead(n) }. */
export interface RemakeVerb {
  action: string;
  gerund: string;
  /** What is in use ("This template is used by 2 posts …"). */
  lead: (n: number) => string;
}

function remakeRequired(e: unknown): RemakeRequiredError | null {
  if (e instanceof ApiError && e.status === 409) {
    const d = e.data as { error?: unknown } | null;
    if (d?.error === "remake_required") {
      return e.data as RemakeRequiredError;
    }
  }
  return null;
}

// What a save the page left before confirming says, wherever the publisher went.
const NOT_SAVED = "Not saved: the change needed your confirmation";

/**
 * The other re-make refusal (SPEC §9): a scheduled send is about to fire, so the save
 * waits until it has sent. A surface shows this one where it blocks (the save bar, the
 * logo's field error), never as a passing toast.
 */
export function isRemakeTooClose(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) {
    return false;
  }
  const d = e.data as { error?: unknown } | null;
  return d?.error === "remake_too_close";
}

/**
 * A template or identity change reaches every scheduled email, and the server refuses
 * such a save until the client has acknowledged those sends by id (409 remake_required,
 * listing them). The flow is server-driven so the dashboard never decides which fields
 * count: `attempt(ack)` runs the write with no acknowledgement; a refusal opens the
 * confirmation with the list the server handed back; confirming retries with those ids;
 * a second refusal (a send scheduled meanwhile) asks again with the fresh list. Resolves
 * to the write's response, or to null when the publisher canceled (the caller then leaves
 * everything as it was). Any other refusal, including 409 remake_too_close (a send about
 * to fire), is rethrown for the surface's own blocking-error home. The confirmation
 * belongs to the page, so `signal` is the page's mount signal: leaving the page closes it,
 * which counts as a cancel, and nothing is saved that the publisher never confirmed; a
 * toast says so, since they are no longer on the page that would show it.
 */
export async function withRemakeConfirm<T>(
  attempt: (ack: string[] | null) => Promise<T>,
  verb: RemakeVerb,
  signal: AbortSignal,
): Promise<T | null> {
  let ack: string[] | null = null;
  for (;;) {
    try {
      return await attempt(ack);
    } catch (err) {
      const required = remakeRequired(err);
      if (!required) {
        throw err;
      }
      const sends = required.sends || [];
      const ok = await confirmRemake(sends, verb, signal);
      if (!ok) {
        // A publisher who pressed Save and left before (or while) the confirmation showed
        // would otherwise never learn the save didn't happen. The toast region is the
        // app's, not the page's, so it shows on whatever page they went to.
        if (signal.aborted) {
          toast(NOT_SAVED);
        }
        return null;
      }
      ack = sends.map((s) => s.id);
    }
  }
}

// The confirmation itself (DESIGN §4): one sentence on what the save reaches, the
// scheduled posts by name, three short facts the publisher scans (what changes, what
// stays, what's next), and the alternative (a second template, which Kestrel does not
// offer yet).
function confirmRemake(
  sends: ScheduledSendRef[],
  verb: RemakeVerb,
  signal: AbortSignal,
): Promise<boolean> {
  const n = sends.length;
  const one = n === 1;
  const noun = `${n} scheduled email${one ? "" : "s"}`;
  return new Promise((resolve) => {
    const m = modal(
      html`<h3>Apply this change to ${noun}?</h3>
        <p class="hint">${verb.lead(n)} ${verb.gerund} applies the change to ${one ? "its email" : "their emails"} too.</p>
        <ul class="remake-list">${sends.map(
          (s) =>
            html`<li><span>${s.subject || html`<em>untitled</em>`}</span><span>sends ${fmt(s.fire_at)}</span></li>`,
        )}</ul>
        <dl class="remake-facts">
        <div><dt>Changes</dt><dd>the look of ${one ? "its email" : "their emails"}</dd></div>
        <div><dt>Stays</dt><dd>${one ? "its content and fire time" : "their content and fire times"}</dd></div>
        <div><dt>Next</dt><dd>send yourself a fresh test${one ? "" : " of each"}</dd></div>
        </dl>
        <p class="hint">To leave scheduled emails as they are while future posts change, you’d need a second template, which Kestrel doesn’t offer yet.</p>
        <div class="actions"><button type="button" id="rmCancel">Cancel</button><button type="button" class="primary" id="rmGo">${verb.action} and apply</button></div>`,
      signal,
    );
    // The page is already gone, so the dialog never showed: nothing was confirmed.
    if (!m.el.isConnected) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const cancel = m.el.querySelector<HTMLButtonElement>("#rmCancel");
    const go = m.el.querySelector<HTMLButtonElement>("#rmGo");
    if (cancel) {
      cancel.onclick = () => {
        m.close();
        done(false);
      };
    }
    if (go) {
      go.onclick = () => {
        m.close();
        done(true);
      };
    }
    // Backdrop click, Escape, and leaving the page close the modal without going through
    // a button.
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        done(false);
      }
    });
    obs.observe(document.body, { childList: true });
    go?.focus();
  });
}

/** The template surface's lead: what is in use by the scheduled posts. */
export const REMAKE_TEMPLATE: RemakeVerb = {
  action: "Save",
  gerund: "Saving",
  lead: (n) =>
    `This template is used by ${n} post${n === 1 ? " that’s" : "s that are"} already scheduled.`,
};

/** The identity surface's lead, for the action the page commits with. */
export const remakeIdentity = (action: string, gerund: string): RemakeVerb => ({
  action,
  gerund,
  lead: (n) =>
    `Your name, tagline, address, and logo ride inside every email, including ${n} post${n === 1 ? " that’s" : "s that are"} already scheduled.`,
});

/**
 * The standing in-use chip (DESIGN §8): the state a template or identity change would
 * reach, read from GET /api/settings `inUse`. A plain label (DESIGN §11): while a save
 * would be refused for a post about to send, `remakeWait` says so in words beside it.
 */
export function inUseChip(inUse: InUseView | null | undefined): Html {
  const sends = inUse?.sends || [];
  if (!sends.length) {
    return html`<span class="set-chip">${icon("info")}No posts scheduled</span>`;
  }
  const n = sends.length;
  return html`<span class="set-chip inuse"><span class="set-chip-dot"></span>In use by ${n} scheduled post${n === 1 ? "" : "s"}</span>`;
}

/**
 * What a surface says while scheduled posts are inside the minimum lead (SPEC §9): a save
 * is refused until they have sent, so it names when and the next step. Empty when none is,
 * or once `retry_after` has passed and a save would go through.
 */
export function remakeWait(inUse: InUseView | null | undefined, now = Date.now()): string {
  const until = inUse?.retry_after;
  if (!inUse || !until || now >= until) {
    return "";
  }
  // retry_after is the last of them to fire, so every send at or before it is inside.
  const n = Math.max(1, inUse.sends.filter((s) => s.fire_at <= until).length);
  return n === 1
    ? `A scheduled post sends at ${fmt(until)}. You can save once it has sent.`
    : `${n} scheduled posts send by ${fmt(until)}. You can save once they have sent.`;
}

/** `remakeWait` as markup to append to a lede or note, marked so `expireRemakeWait` can
 *  take it down; nothing when there is nothing to say. */
export function remakeWaitHtml(inUse: InUseView | null | undefined): Html | null {
  const wait = remakeWait(inUse);
  return wait ? html`<span data-remake-wait> ${wait}</span>` : null;
}

/**
 * Take down every `remakeWaitHtml` sentence under `root` at `retry_after`, when a save
 * would go through, so a page left open never names a time that has passed.
 */
export function expireRemakeWait(
  root: HTMLElement,
  inUse: InUseView | null | undefined,
  signal: AbortSignal,
): void {
  const until = inUse?.retry_after;
  if (!until) {
    return;
  }
  at(
    until,
    () => {
      for (const el of root.querySelectorAll("[data-remake-wait]")) {
        el.remove();
      }
    },
    signal,
  );
}

/**
 * After a save that applied to scheduled emails, the toast says how many and that a
 * test is needed again (DESIGN §4); with none, the plain confirmation.
 */
export function savedToast(what: string, remade: readonly unknown[] | null | undefined): string {
  const n = (remade || []).length;
  if (!n) {
    return what;
  }
  return `${what} and applied to ${n} scheduled email${n === 1 ? "" : "s"}. Send yourself a test of each.`;
}
