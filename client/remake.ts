// The re-make confirmation (SPEC §6, §9; DESIGN §5): the in-use chip, the applied
// notice, and the confirm-then-save flow the Template and Settings pages share.

import type { InUseView, RemakeRequiredError, ScheduledSendRef } from "../shared/settings";
import { ApiError } from "./api";
import { fmt, modal } from "./helpers";
import { type Html, html } from "./html";
import { icon } from "./icons";

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
 * to fire), is rethrown for the surface's own blocking-error home.
 */
export async function withRemakeConfirm<T>(
  attempt: (ack: string[] | null) => Promise<T>,
  verb: RemakeVerb,
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
      const ok = await confirmRemake(sends, verb);
      if (!ok) {
        return null;
      }
      ack = sends.map((s) => s.id);
    }
  }
}

// The confirmation itself (DESIGN §5): one sentence on what the save reaches, the
// scheduled posts by name, three short facts the publisher scans (what changes, what
// stays, what's next), and the alternative (a second template, which Kestrel does not
// offer yet).
function confirmRemake(sends: ScheduledSendRef[], verb: RemakeVerb): Promise<boolean> {
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
        <p class="hint">To leave scheduled emails as they are while future posts change, you'd need a second template, which Kestrel doesn't offer yet.</p>
        <div class="actions"><button type="button" id="rmCancel">Cancel</button><button type="button" class="primary" id="rmGo">${verb.action} and apply</button></div>`,
    );
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
    // Backdrop click / Escape close the modal without going through a button.
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
    `This template is used by ${n} post${n === 1 ? " that's" : "s that are"} already scheduled.`,
};

/** The identity surface's lead, for the action the page commits with. */
export const remakeIdentity = (action: string, gerund: string): RemakeVerb => ({
  action,
  gerund,
  lead: (n) =>
    `Your name, tagline, address, and logo ride inside every email, including ${n} post${n === 1 ? " that's" : "s that are"} already scheduled.`,
});

/**
 * The standing in-use chip (DESIGN §3): the state a template or identity change would
 * reach, read from GET /api/settings `inUse`. `forIdentity` narrows it for the identity
 * surface: a field the template does not render is not in use at all.
 */
export function inUseChip(inUse: InUseView | null | undefined, forIdentity = false): Html {
  const sends = inUse?.sends || [];
  if (forIdentity && !(inUse?.identityFields || []).length) {
    return html`<span class="set-chip" title="The email template doesn't use your name, tagline, address, or logo.">${icon("info")}Not used by the email template</span>`;
  }
  if (!sends.length) {
    return html`<span class="set-chip">${icon("info")}No posts scheduled</span>`;
  }
  const n = sends.length;
  const title = inUse?.retry_after
    ? `One sends at ${fmt(inUse.retry_after)}; saving waits until it has sent.`
    : null;
  return title
    ? html`<span class="set-chip inuse" title="${title}"><span class="set-chip-dot"></span>In use by ${n} scheduled post${n === 1 ? "" : "s"}</span>`
    : html`<span class="set-chip inuse"><span class="set-chip-dot"></span>In use by ${n} scheduled post${n === 1 ? "" : "s"}</span>`;
}

// "Sep 20 at 4:12 PM": the moment a notice names, read as a clause rather than a stamp.
const fmtAt = (ms: number) =>
  `${new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric" })} at ${new Date(
    ms,
  ).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" })}`;

/**
 * The applied-change notice (SPEC §8; DESIGN §2 home ⑥): a template or identity change
 * re-made the scheduled emails at `at`. One text for both surfaces; `n` is how many posts
 * it names (the dashboard's aggregate) or 1 for the post's own. It states the event and
 * the next step: the window is the review (SPEC §6), and a cleared notice can afford to
 * say so.
 */
export function appliedNoticeHtml(at: number, n: number, onPost: boolean): Html {
  const who = onPost ? "this post" : `${n} scheduled post${n === 1 ? "" : "s"}`;
  return html`A template or identity change made <strong>${fmtAt(at)}</strong> was applied to ${who}. Send a fresh test email to review the changes.`;
}

/**
 * After a save that applied to scheduled emails, the toast says how many and that a
 * test is needed again (DESIGN §2); with none, the plain confirmation.
 */
export function savedToast(what: string, remade: readonly unknown[] | null | undefined): string {
  const n = (remade || []).length;
  if (!n) {
    return what;
  }
  return `${what} and applied to ${n} scheduled email${n === 1 ? "" : "s"}. Send yourself a test of each.`;
}
