// Settings' Notifications section (SPEC §8): where Kestrel tells the publisher about their
// sends is a list of addresses, each added or removed saved at once; how it gets there, and from whom,
// is shown read-only beside it with how the last one went, and its last row says what these
// emails can't carry, with Send a test alert to prove the Cloudflare alert for it (SPEC §12).

import { notificationSender } from "../../shared/publication";
import {
  type AlertTestResponse,
  MAX_NOTIFY_ADDRESSES,
  missedAddresses,
  type NotificationStatusKind,
  type NotificationTestResponse,
  type SettingsResponse,
} from "../../shared/settings";
import { api } from "../api";
import { timeAt } from "../time_zone";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { busy, toast } from "../ui/widgets";
import { addressListHtml, mountAddressList } from "./address_list";
import { providerLabel } from "./deploy";
import { chip, message, type SectionHandle, type SettingsPage, secHead, senderLine } from "./page";

/** How notifications travel, as the publisher reads it: through the provider, or, where the
 *  provider is the stand-in that delivers nothing, said so. */
function sentThroughLabel(d: SettingsResponse["deployment"]): string {
  if (standIn(d)) {
    return "Local stand-in: nothing is delivered";
  }
  return d.provider === "none"
    ? "Your email provider, once one is connected"
    : `Your email provider (${providerLabel(d.provider)})`;
}

/** Whether notifications reach no inbox: the fake provider with no simulation standing in. */
function standIn(d: SettingsResponse["deployment"]): boolean {
  return d.provider === "fake" && d.simulation === null;
}

/** The Set up alerts guide, which creates the Cloudflare Monitors, in the Docs tab. */
const ALERTS_DOCS_HREF = "#/docs/alerts";

/** What Send a test alert is for, beside it until its answer takes the line. It never says
 *  the alerts exist, which the app can't tell (SPEC §12). */
const ALERT_TEST_HINT = "Once the alerts are set up, checks that the first one reaches your inbox.";

const NOTIFICATION_KINDS: Record<NotificationStatusKind, string> = {
  finished: "went out",
  refused: "provider refusing",
  unavailable: "provider down over an hour",
  stuck: "in flight too long",
  wedged: "waiting to be resolved",
  missed: "missed fire time",
  no_receipts: "no receipts from the provider",
  import: "list imported",
  sandbox: "signup refused by the SES sandbox",
  not_sending: "email not going out",
  not_sending_held: "email not going out",
  test: "test",
};

/** What a status line is about: the send and what happened, or just "test notification". */
function aboutNotification(n: { kind: NotificationStatusKind; subject: string }): string {
  if (n.kind === "test") {
    return "test notification";
  }
  // A sandbox notice is about no send or import, so it has no subject to lead with.
  return n.subject ? `${n.subject} (${NOTIFICATION_KINDS[n.kind]})` : NOTIFICATION_KINDS[n.kind];
}

/** The last delivered notification, and a newer failure when the channel has stopped working. */
function notificationStatusHtml(status: SettingsResponse["notification_status"]): Html {
  const { last_sent: lastSent, last_failure: lastFailure } = status;
  if (lastFailure) {
    return html`<span class="set-pill danger">Not delivered</span> <span class="muted">${timeAt(lastFailure.at)}, ${aboutNotification(lastFailure)}: ${lastFailure.error}</span>`;
  }
  if (lastSent) {
    return html`<span class="set-pill ok">${icon("check")}Delivered</span> <span class="muted">${timeAt(lastSent.at)}, ${aboutNotification(lastSent)}</span>`;
  }
  return html`<span class="muted">None yet</span>`;
}

const NOTIFY_IDS = { chips: "notifyChips", input: "notifyTo", add: "notifyAdd" };

export function notificationsSection(page: SettingsPage): Html {
  const d = page.data.deployment;
  return html`
    <section class="set-sec">
      ${secHead("notifications", chip("editable", "Editable"))}
      <p class="set-lede">Kestrel emails you when a send goes out, and right away if a send runs into a problem.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field">
            <label for="notifyTo">Send notifications to</label>
            <p class="field-hint" style="margin:0">Each address gets every notification. Add whoever runs Kestrel for you, so they’re told too. Up to ${MAX_NOTIFY_ADDRESSES}.</p>
          </div>
          ${addressListHtml(NOTIFY_IDS)}
          <div class="row"><button type="button" class="secondary" id="notifyTest">Send a test notification</button><span class="field-hint" id="notifyTestHint"></span></div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">Sent through</div><div class="set-kv-v">${sentThroughLabel(d)}</div>
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono" id="notifyFrom">${notifyFromLine(page)}</span></div>
          <div class="set-kv-k">Last notification</div><div class="set-kv-v" id="notifyStatus">${notificationStatusHtml(page.data.notification_status)}</div>
          <div class="set-kv-k">Cloudflare alerts</div>
          <div class="set-kv-v set-kv-stack" id="alertsRow">
            <span class="muted">Notifications are sent by Kestrel, through your email provider. If either has a problem, such as the provider not sending or Kestrel itself stopping, a notification can’t reach you. To be told about these problems, <a class="set-link" href="${ALERTS_DOCS_HREF}">set up Cloudflare alerts</a>.</span>
            <div class="row"><button type="button" class="ghost" id="alertTest">Send a test alert</button><span class="field-hint" id="alertTestHint">${ALERT_TEST_HINT}</span></div>
          </div>
        </div>
      </div>
    </section>`;
}

/** The From a notification carries: Kestrel, on the saved publication name's behalf, over
 *  the deploy-time address, by the rule the Worker sends it with. */
function notifyFromLine(page: SettingsPage): string {
  return senderLine(notificationSender(page.saved().name, page.data.deployment.from_address));
}

/** The addresses save as they are added or removed, so the list shown is the saved one;
 *  the test goes to the saved addresses only (the server never takes one from the request),
 *  so it waits for the first. Its outcome is the channel's latest word, so the status line
 *  takes it in place. */
export function mountNotifications(root: HTMLElement, page: SettingsPage): SectionHandle {
  const test = $<HTMLButtonElement>("#notifyTest", root);
  const testHint = $("#notifyTestHint", root);
  const status = $("#notifyStatus", root);
  const from = $("#notifyFrom", root);
  const alertTest = $<HTMLButtonElement>("#alertTest", root);
  const alertHint = $("#alertTestHint", root);
  const list = mountAddressList(root, page, {
    ids: NOTIFY_IDS,
    key: "notifyTo",
    name: "notifications",
    empty: "No addresses yet, so Kestrel emails no one. Add yours below.",
    max: {
      count: MAX_NOTIFY_ADDRESSES,
      full: `Notifications go to at most ${MAX_NOTIFY_ADDRESSES} addresses. Remove one to add another.`,
    },
  });
  const refreshTest = () => {
    const reason = page.state.notifyTo.length === 0 ? "Add an address to send a test." : "";
    test.disabled = Boolean(reason);
    testHint.textContent = reason;
  };
  test.onclick = () =>
    busy(test, "Sending…", async () => {
      try {
        const r = await api<NotificationTestResponse>("/api/settings/notifications/test", {
          method: "POST",
        });
        const reached = r.to.filter((a) => !r.failed.some((f) => f.email === a));
        toast(
          standIn(page.data.deployment)
            ? `Test notification recorded for ${reached.join(", ")} (local stand-in: nothing is delivered)`
            : `Test notification sent to ${reached.join(", ")}`,
        );
        // Some addresses missed it: the status row says which, as the server recorded it.
        const error = missedAddresses(r.to, r.failed);
        setHtml(
          status,
          notificationStatusHtml({
            last_sent: { kind: "test", subject: "", at: Date.now() },
            last_failure: error ? { kind: "test", subject: "", at: Date.now(), error } : null,
          }),
        );
      } catch (err) {
        // The outcome's home is the channel's status row, as it is for every notification;
        // a toast would say it a second time.
        setHtml(
          status,
          notificationStatusHtml({
            last_sent: null,
            last_failure: { kind: "test", subject: "", at: Date.now(), error: message(err) },
          }),
        );
      }
    });
  alertTest.onclick = () =>
    busy(alertTest, "Sending…", async () => {
      try {
        const r = await api<AlertTestResponse>("/api/settings/notifications/alert-test", {
          method: "POST",
        });
        alertHint.textContent = `Logged at ${timeAt(r.at)}. Cloudflare’s alert email should arrive in about five minutes, then a Resolved email.`;
      } catch (err) {
        alertHint.textContent = message(err);
      }
    });
  // The From follows the saved name, so a rename shows here once it's saved.
  const repaint = () => {
    refreshTest();
    from.textContent = notifyFromLine(page);
  };
  repaint();
  return {
    repaint,
    reset() {
      list.reset?.();
      repaint();
    },
  };
}
