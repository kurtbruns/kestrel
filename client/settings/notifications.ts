// Settings' Notifications section (SPEC §8): where Kestrel tells the publisher about their
// sends is a preference, committed through the save bar; how it gets there, and from whom,
// is deploy config, shown read-only beside it with how the last one went.

import type {
  NotificationStatusKind,
  NotificationTestResponse,
  SettingsResponse,
} from "../../shared/settings";
import { api } from "../api";
import { $ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { busy, toast } from "../ui/widgets";
import { providerLabel } from "./deploy";
import { chip, message, type SectionHandle, type SettingsPage, secHead } from "./page";

/** How the deploy-time notification channel reads to the publisher. */
function notifyChannelLabel(
  channel: SettingsResponse["deployment"]["notifyChannel"],
  provider: string,
): string {
  switch (channel) {
    case "cloudflare":
      return "Cloudflare Email, separate from your newsletter’s provider";
    case "provider":
      return provider === "none"
        ? "Your email provider, once one is connected"
        : `Your email provider (${providerLabel(provider)})`;
    default:
      return "No email provider configured, so nothing is delivered";
  }
}

const NOTIFICATION_KINDS: Record<NotificationStatusKind, string> = {
  finished: "went out",
  refused: "provider refusing",
  stuck: "in flight too long",
  wedged: "waiting to be resolved",
  missed: "missed fire time",
  test: "test",
};

/** What a status line is about: the send and what happened, or just "test notification". */
function aboutNotification(n: { kind: NotificationStatusKind; subject: string }): string {
  return n.kind === "test" ? "test notification" : `${n.subject} (${NOTIFICATION_KINDS[n.kind]})`;
}

/** The last delivered notification, and a newer failure when the channel has stopped working. */
function notificationStatusHtml(status: SettingsResponse["notificationStatus"]): Html {
  const { lastSent, lastFailure } = status;
  if (lastFailure) {
    return html`<span class="set-pill danger">Not delivered</span> <span class="muted">${fmt(lastFailure.at)}, ${aboutNotification(lastFailure)}: ${lastFailure.error}</span>`;
  }
  if (lastSent) {
    return html`<span class="set-pill ok">${icon("check")}Delivered</span> <span class="muted">${fmt(lastSent.at)}, ${aboutNotification(lastSent)}</span>`;
  }
  return html`<span class="muted">None yet</span>`;
}

export function notificationsSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  return html`
    <section class="set-sec">
      ${secHead("Notifications", chip("editable", "Editable"))}
      <p class="set-lede">Kestrel emails you when a send goes out, and right away if a send runs into a problem.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field" style="margin:0">
            <label for="notifyTo">Send notifications to</label>
            <input type="email" id="notifyTo" value="${page.state.notifyTo}" placeholder="you@example.com" autocomplete="off">
            <p class="field-hint">One address. Leave blank for no notifications.</p>
          </div>
          <div class="row"><button type="button" class="ghost" id="notifyTest">Send a test notification</button><span class="field-hint" id="notifyTestHint"></span></div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">Sent through</div><div class="set-kv-v">${notifyChannelLabel(d.notifyChannel, d.provider)}</div>
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono">${d.notifyFrom}</span></div>
          <div class="set-kv-k">Last notification</div><div class="set-kv-v" id="notifyStatus">${notificationStatusHtml(page.data.notificationStatus)}</div>
        </div>
        <div class="set-note">${icon("readonly")}<span>The channel and its sender are set at deploy. ${d.notifyChannel === "provider" ? "Notifications go through your newsletter’s own provider, so one about the provider refusing your account cannot reach you; Cloudflare’s email avoids that. " : ""}See the <a class="set-link" href="#/docs/notifications">setup guide</a>.</span></div>
      </div>
    </section>`;
}

/** The address rides the save bar; the test goes to the SAVED address only (the server
 *  never takes one from the request), so it waits for a save. Its outcome is the channel's
 *  latest word, so the status line takes it in place. */
export function mountNotifications(root: HTMLElement, page: SettingsPage): SectionHandle {
  const toEl = $<HTMLInputElement>("#notifyTo", root);
  const test = $<HTMLButtonElement>("#notifyTest", root);
  const testHint = $("#notifyTestHint", root);
  const status = $("#notifyStatus", root);
  toEl.addEventListener("input", () => {
    page.state.notifyTo = toEl.value.trim().toLowerCase();
    page.changed();
  });
  const refreshTest = () => {
    const saved = page.saved().notifyTo;
    const reason = !saved
      ? "Save an address to send a test."
      : page.state.notifyTo !== saved
        ? "Save first: the test goes to the saved address."
        : "";
    test.disabled = Boolean(reason);
    testHint.textContent = reason;
  };
  test.onclick = () =>
    busy(test, "Sending…", async () => {
      try {
        const r = await api<NotificationTestResponse>("/api/settings/notifications/test", {
          method: "POST",
        });
        toast(
          r.channel === "fake"
            ? `Test notification recorded for ${r.to} (no email provider configured, so nothing is delivered)`
            : `Test notification sent to ${r.to}`,
        );
        setHtml(
          status,
          notificationStatusHtml({
            lastSent: { kind: "test", subject: "", at: Date.now() },
            lastFailure: null,
          }),
        );
      } catch (err) {
        // The outcome's home is the channel's status row, as it is for every notification;
        // a toast would say it a second time.
        setHtml(
          status,
          notificationStatusHtml({
            lastSent: null,
            lastFailure: { kind: "test", subject: "", at: Date.now(), error: message(err) },
          }),
        );
      }
    });
  refreshTest();
  return {
    repaint: refreshTest,
    reset() {
      toEl.value = page.state.notifyTo;
      refreshTest();
    },
  };
}
