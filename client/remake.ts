// @ts-nocheck
// The re-make confirmation (SPEC §6, §9; DESIGN §5): the in-use chip, the applied
// notice, and the confirm-then-save flow the Template and Settings pages share.

import { esc, fmt, modal } from "./helpers";
import { SET_ICON } from "./settings";

// A template or identity change reaches every scheduled email, and the server refuses
// such a save until the client has acknowledged those sends by id (409
// remake_required, listing them). The flow is server-driven so the dashboard never
// decides which fields count: `attempt(ack)` runs the write with no acknowledgement;
// a refusal opens the confirmation with the list the server handed back; confirming
// retries with those ids; a second refusal (a send scheduled meanwhile) asks again
// with the fresh list. Resolves to the write's response, or to null when the
// publisher canceled (the caller then leaves everything as it was). Any other
// refusal, including 409 remake_too_close (a send about to fire), is rethrown for the
// surface's own blocking-error home.
export async function withRemakeConfirm(attempt, verb) {
  let ack = null;
  for (;;) {
    try {
      return await attempt(ack);
    } catch (err) {
      if (err.status !== 409 || err.data?.error !== "remake_required") {
        throw err;
      }
      const sends = err.data.sends || [];
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
// offer yet). `verb` names the commit: { action: "Save", gerund: "Saving", lead(n) },
// where `lead` says what is in use ("This template is used by 2 posts …").
function confirmRemake(sends, verb) {
  const n = sends.length;
  const one = n === 1;
  const noun = `${n} scheduled email${one ? "" : "s"}`;
  return new Promise((resolve) => {
    const m = modal(
      `<h3>Apply this change to ${esc(noun)}?</h3>` +
        `<p class="hint">${esc(verb.lead(n))} ${esc(verb.gerund)} applies the change to ${one ? "its email" : "their emails"} too.</p>` +
        `<ul class="remake-list">${sends
          .map(
            (s) =>
              `<li><span>${esc(s.subject) || "<em>untitled</em>"}</span><span>sends ${esc(fmt(s.fire_at))}</span></li>`,
          )
          .join("")}</ul>` +
        `<dl class="remake-facts">` +
        `<div><dt>Changes</dt><dd>the look of ${one ? "its email" : "their emails"}</dd></div>` +
        `<div><dt>Stays</dt><dd>${one ? "its content and fire time" : "their content and fire times"}</dd></div>` +
        `<div><dt>Next</dt><dd>send yourself a fresh test${one ? "" : " of each"}</dd></div>` +
        `</dl>` +
        `<p class="hint">To leave scheduled emails as they are while future posts change, you'd need a second template, which Kestrel doesn't offer yet.</p>` +
        `<div class="actions"><button type="button" id="rmCancel">Cancel</button><button type="button" class="primary" id="rmGo">${esc(verb.action)} and apply</button></div>`,
    );
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    m.el.querySelector("#rmCancel").onclick = () => {
      m.close();
      done(false);
    };
    m.el.querySelector("#rmGo").onclick = () => {
      m.close();
      done(true);
    };
    // Backdrop click / Escape close the modal without going through a button.
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        done(false);
      }
    });
    obs.observe(document.body, { childList: true });
    m.el.querySelector("#rmGo").focus();
  });
}
// The two leads: what is in use by the scheduled posts.
export const REMAKE_TEMPLATE = {
  action: "Save",
  gerund: "Saving",
  lead: (n) =>
    `This template is used by ${n} post${n === 1 ? " that's" : "s that are"} already scheduled.`,
};
export const remakeIdentity = (action, gerund) => ({
  action,
  gerund,
  lead: (n) =>
    `Your name, tagline, address, and logo ride inside every email, including ${n} post${n === 1 ? " that's" : "s that are"} already scheduled.`,
});
// The standing in-use chip (DESIGN §3): the state a template or identity change would
// reach, read from GET /api/settings `inUse`. `identityFields` narrows it for the
// identity surface: a field the template does not render is not in use at all.
export function inUseChip(inUse, forIdentity = false) {
  const sends = inUse?.sends || [];
  if (forIdentity && !(inUse?.identityFields || []).length) {
    return `<span class="set-chip" title="The email template doesn't use your name, tagline, address, or logo.">${SET_ICON.info}Not used by the email template</span>`;
  }
  if (!sends.length) {
    return `<span class="set-chip">${SET_ICON.info}No posts scheduled</span>`;
  }
  const n = sends.length;
  const title = inUse.retry_after
    ? ` title="One sends at ${esc(fmt(inUse.retry_after))}; saving waits until it has sent."`
    : "";
  return `<span class="set-chip inuse"${title}><span class="set-chip-dot"></span>In use by ${n} scheduled post${n === 1 ? "" : "s"}</span>`;
}
// "Sep 20 at 4:12 PM": the moment a notice names, read as a clause rather than a stamp.
const fmtAt = (ms) =>
  `${new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric" })} at ${new Date(
    ms,
  ).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" })}`;
// The applied-change notice (SPEC §8; DESIGN §2 home ⑥): a template or identity change
// re-made the scheduled emails at `at`. One text for both surfaces; `n` is how many
// posts it names (the dashboard's aggregate) or 1 for the post's own. It states the
// event and the next step: the window is the review (SPEC §6), and a cleared notice
// can afford to say so.
export function appliedNoticeHtml(at, n, onPost) {
  const who = onPost ? "this post" : `${n} scheduled post${n === 1 ? "" : "s"}`;
  return `A template or identity change made <strong>${esc(fmtAt(at))}</strong> was applied to ${who}. Send a fresh test email to review the changes.`;
}
// After a save that applied to scheduled emails, the toast says how many and that a
// test is needed again (DESIGN §2); with none, the plain confirmation.
export function savedToast(what, remade) {
  const n = (remade || []).length;
  if (!n) {
    return what;
  }
  return `${what} and applied to ${n} scheduled email${n === 1 ? "" : "s"}. Send yourself a test of each.`;
}
