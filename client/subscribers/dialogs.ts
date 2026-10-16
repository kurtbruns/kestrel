// The subscriber dialogs: adding one (the list, the dashboard's quick actions), and
// viewing, unsubscribing, blocking, unblocking, clearing, or erasing one (the list's row menu).

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type { OptIn } from "../../shared/imports";
import { SUPPRESSION_FLAG } from "../../shared/subscriber_meanings";
import type {
  BlockResponse,
  ClearSuppressionResponse,
  EraseResponse,
  ErasureAcknowledgementRequired,
  SubscribeAction,
  SubscribeResponse,
  Subscriber,
} from "../../shared/subscribers";
import { ApiError, api, describeError } from "../api";
import { notConnectedAddLine, providerNotConnected } from "../deployment";
import { $ } from "../ui/dom";
import { fmt } from "../ui/format";
import { html } from "../ui/html";
import { busy, modal, toast } from "../ui/widgets";
import { evidenceText, joinedVia, originName } from "./provenance";

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
        const add = (acknowledge: boolean) =>
          api<SubscribeResponse>("/api/subscribers", {
            method: "POST",
            json: acknowledge ? { email: addr, acknowledge_erasure: true } : { email: addr },
          });
        let r: SubscribeResponse;
        try {
          r = await add(false);
        } catch (e) {
          const erased = erasureRefusal(e);
          if (!erased) {
            throw e;
          }
          if (!(await confirmErasedAdd(addr, erased.erased_at, signal))) {
            return;
          }
          r = await add(true);
        }
        m.close();
        toast(addedMessage(addr, r.action));
        onDone();
      } catch (e) {
        // A refusal about the address goes under it; anything else, above the buttons.
        m.error(describeError(e), e instanceof ApiError && e.field === "email" ? input : undefined);
      }
    });
}

/** The server's refusal to mail an erased address without the publisher's say-so, or null. */
function erasureRefusal(e: unknown): ErasureAcknowledgementRequired | null {
  return e instanceof ApiError && e.status === 409 && e.code === "erasure_acknowledgement_required"
    ? (e.data as ErasureAcknowledgementRequired)
    : null;
}

/**
 * Asked over the Add dialog when the address was erased (SPEC §7): the person may come back,
 * but on their own wish, so the publisher confirms they asked. Resolves true to send the
 * confirmation; false (Cancel, Escape, or leaving the page) leaves the Add dialog as it was.
 */
function confirmErasedAdd(addr: string, erasedAt: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(
      html`<h3>Send to an erased address?</h3><p class="hint"><strong>${addr}</strong> was erased at the person’s request on ${fmt(erasedAt)}. Send a confirmation only if they’ve asked to join again. They rejoin only by confirming it, which lifts the erasure.</p><div class="actions"><button type="button" id="eaCancel">Cancel</button><button type="button" class="primary" id="eaGo">Send confirmation</button></div>`,
      signal,
    );
    // The page is already gone, so the dialog never showed: nothing was confirmed.
    if (!m.el.isConnected) {
      resolve(false);
      return;
    }
    let answer = false;
    $("#eaCancel", m.el).onclick = m.close;
    $("#eaGo", m.el).onclick = () => {
      answer = true;
      m.close();
    };
    // However it closes (a button, Escape, the backdrop, the page going), it answers once.
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        resolve(answer);
      }
    });
    obs.observe(document.body, { childList: true });
    $("#eaCancel", m.el).focus();
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

const STATUS_WORDS: Record<Subscriber["status"], string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  unsubscribed: "Unsubscribed",
};

const OPT_IN_WORDS: Record<OptIn, string> = {
  double: "Double",
  single: "Single",
  unknown: "Unknown",
};

/**
 * One subscriber, on request: how they joined, when, and the evidence (SPEC §7). It only
 * shows: nothing in it can be changed, since it is the record of how they came to be here.
 */
/**
 * View subscriber: how they joined and, when the address is suppressed, its flag and the
 * provider's or publisher's words for it, which the list's plain-label pills don't carry.
 */
export function viewSubscriberModal(
  sub: Subscriber,
  signal: AbortSignal,
  suppression?: { label: string; detail: string | null },
): void {
  const evidence = evidenceText(sub.consent_evidence);
  const imported = sub.import_id !== null;
  const m = modal(
    html`<h3 class="sub-title">${sub.email}</h3><p class="hint">${STATUS_WORDS[sub.status]}</p>
    <dl class="sub-dl">
      <dt>How they joined</dt><dd>${joinedVia(sub) ?? (sub.status === "pending" ? "Signed up here, not confirmed yet" : "Signed up here, never confirmed")}</dd>
      ${
        imported
          ? html`<dt>Origin</dt><dd>${originName(sub.origin) ?? "Unknown"}</dd>
            <dt>Opt-in</dt><dd>${OPT_IN_WORDS[sub.opt_in]}</dd>
            <dt>Import</dt><dd><code>${sub.import_id ?? ""}</code></dd>`
          : null
      }
      <dt>Joined</dt><dd>${
        // When the row was added here, as the roster's Joined column shows it. An import
        // records the file's own date (its confirmed_at, else its subscribed_at) as the
        // confirmation below, which the note says is the file's.
        fmt(sub.created_at)
      }</dd>
      <dt>Confirmed</dt><dd>${fmt(sub.confirmed_at)}</dd>
      ${sub.unsubscribed_at ? html`<dt>Left</dt><dd>${fmt(sub.unsubscribed_at)}</dd>` : null}
      <dt>Evidence</dt><dd>${evidence ? html`<pre class="sub-evidence">${evidence}</pre>` : "None recorded"}</dd>
      ${suppression ? html`<dt>Suppressed</dt><dd>${suppression.label}${suppression.detail ? html`: ${suppression.detail}` : null}</dd>` : null}
    </dl>
    ${imported ? html`<p class="hint sub-note">The origin, opt-in, confirmation date, and evidence are what the imported file said, not something Kestrel recorded itself.</p>` : null}
    <div class="actions"><button type="button" id="vsClose">Close</button></div>`,
    signal,
  );
  $("#vsClose", m.el).onclick = m.close;
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
        await api<ClearSuppressionResponse>(`/api/suppressions/${encodeURIComponent(sub.email)}`, {
          method: "DELETE",
        });
        m.close();
        toast(`Unblocked ${sub.email}`);
        onDone();
      } catch (e) {
        m.error(describeError(e));
      }
    });
}

/**
 * Clear lifts a bounce or a complaint, which records someone else's verdict on the address
 * (the provider's, or the previous service's), so it is the riskier way back to mailing it:
 * the dialog says the address failed or reported spam (SPEC §7). A bounce is cleared once the
 * publisher knows its cause is gone. A complaint was the person's own act, and providers
 * tolerate far fewer of them, so only the person asking for the mail again clears one.
 */
export function confirmClear(
  sub: Subscriber,
  flag: "bounced" | "complaint",
  onDone: () => void,
  signal: AbortSignal,
): void {
  const what = flag === "bounced" ? "bounce" : "complaint";
  const why =
    flag === "bounced"
      ? "an address where mail failed. Clear it only when you know the reason is gone, such as a reader who tells you their mailbox is fixed"
      : "an address that reported your mail as spam. Clear it only when they’ve asked you to send them your posts again";
  const mailed =
    sub.status === "confirmed"
      ? "They’re confirmed, so they’ll receive your posts again."
      : "They’ll receive posts again only once they’re confirmed.";
  const m = modal(
    html`<h3>Clear this ${what}?</h3><p class="hint">Lets mail go again to <strong>${sub.email}</strong>, ${why}. ${mailed}</p><div class="actions"><button type="button" id="cCancel">Cancel</button><button type="button" class="danger" id="cGo">Clear</button></div>`,
    signal,
  );
  const go = $<HTMLButtonElement>("#cGo", m.el);
  $("#cCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Clearing…", async () => {
      m.clearError();
      try {
        await api<ClearSuppressionResponse>(`/api/suppressions/${encodeURIComponent(sub.email)}`, {
          method: "DELETE",
        });
        m.close();
        toast(`Cleared the ${what} on ${sub.email}`);
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
    html`<h3>Erase this subscriber?</h3><p class="hint">Deletes <strong>${sub.email}</strong> and how they joined, and past sends show an erased recipient in its place. The address is kept only so it’s never mailed again. This can’t be undone. They can still rejoin by subscribing and confirming themselves.</p><div class="actions"><button type="button" id="eCancel">Cancel</button><button type="button" class="danger" id="eGo">Erase</button></div>`,
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
  complaint: "complaint",
  import_complaint: "complaint",
  manual: "block",
};

/** What the erasure left: the marker, or the bounce, complaint, or block the address had. */
function erasedMessage({ erased }: EraseResponse): string {
  return erased.suppression === "erased"
    ? `Erased ${erased.email}`
    : `Erased ${erased.email}. Its ${KEPT_SUPPRESSION[erased.suppression] ?? "suppression"} still stands`;
}
