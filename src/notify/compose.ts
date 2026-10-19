/**
 * The words of each notification to the publisher (SPEC §8): what happened, the numbers
 * or the provider's words that matter, and a link to the send (or, for an import, the list)
 * in the admin UI. Plain
 * text first, with a minimal HTML twin, because it is a message about the newsletter to
 * its publisher, not a post: it carries no template, no identity, and no unsubscribe link.
 */

import { dashboardLink } from "../../shared/dashboard_link";
import type { OutcomeCounts } from "../../shared/imports";
import { isSendOwnHalt, refusalAdvice } from "../../shared/sends";
import type { DueImportNotification, DueNotification } from "../db/notifications";
import type { Config } from "../env";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import { STUCK_THRESHOLD_MS } from "../lib/time";
import type { RenderedEmail } from "../render/render";

/** A moment as the publisher reads it in a notification: UTC, to the minute. */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** The send's page in the admin UI: the record once sent, the live watch before. Carried
 *  in the query, so it still opens the send after an Access login (`dashboardLink`). */
export function sendLink(config: Config, sendId: string): string {
  return dashboardLink(config.appOrigin, `/sent/${encodeURIComponent(sendId)}`);
}

/** Paragraphs and a closing link, as both a text and an HTML body. */
function message(subject: string, paragraphs: string[], link: string): RenderedEmail {
  const text = `${paragraphs.join("\n\n")}\n\n${link}\n`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p><a href="${escapeHtmlAttr(link)}">${escapeHtml(link)}</a></p>
</body></html>`;
  return { subject, html, text };
}

/** Write the notification for one event, from the send as it stands now. */
export function composeNotification(n: DueNotification, config: Config): RenderedEmail {
  const link = sendLink(config, n.send_id);
  const title = `"${n.subject}"`;
  switch (n.kind) {
    case "finished": {
      const accepted = n.c_accepted + n.c_delivered + n.c_bounced + n.c_complained;
      const audience = accepted + n.c_unsent + n.c_skipped + n.c_pending + n.c_in_flight;
      return message(
        `Sent: ${n.subject}`,
        [
          `${title} finished sending${n.completed_at ? ` at ${when(n.completed_at)}` : ""}.`,
          `Accepted by the provider: ${accepted} of ${audience}. Unsent: ${n.c_unsent}. Skipped (unsubscribed or suppressed since it was scheduled): ${n.c_skipped}.`,
          "Delivery receipts, bounces, and complaints keep arriving after this; the record shows them as they land.",
        ],
        link,
      );
    }
    case "refused":
      if (n.halt_cause === "not_connected") {
        // Held for want of a provider (SPEC §9): no provider is refusing anything, so say
        // what it is, and the fix once.
        return message(
          `Problem with ${title}: no email provider is connected`,
          [
            `No email provider is connected to this deployment, so ${title} is held where it is.`,
            refusalAdvice(n.halt_cause),
            "No one has been marked unsent because of this. The send keeps trying, at most an hour apart, and goes out at the first try after a provider is connected, mailing no one twice. Any other post that comes due meanwhile waits with it, and you are not told again.",
          ],
          link,
        );
      }
      if (isSendOwnHalt(n.halt_cause)) {
        // The provider refuses this send's own email, not the account: no other send waits
        // on it (SPEC §12).
        return message(
          `Problem with ${title}: the provider is refusing it`,
          [
            `The email provider is refusing ${title} itself, so it is paused where it is. The provider said: ${n.halt_error || "no detail given"}`,
            refusalAdvice(n.halt_cause),
            "No one has been marked unsent because of this. The send keeps trying, at most an hour apart, mailing no one twice. Other posts go out as usual.",
          ],
          link,
        );
      }
      return message(
        `Problem with ${title}: the provider is refusing your account`,
        [
          `The email provider is refusing this account, so ${title} is paused where it is. The provider said: ${n.halt_error || "no detail given"}`,
          refusalAdvice(n.halt_cause),
          "No one has been marked unsent because of this. The send keeps trying, at most an hour apart, and resumes on its own at the next try after the account is fixed, mailing no one twice. Any other post that comes due meanwhile waits with it, and you are not told again.",
        ],
        link,
      );
    case "stuck":
      return message(
        `Problem with ${title}: nothing has gone out for ${minutes(STUCK_THRESHOLD_MS)} minutes`,
        [
          `${title} has handed off no one since ${when(n.progress_at ?? n.started_at ?? n.episode)}, with no retry or provider problem to explain it: ${n.c_pending + n.c_in_flight} recipients have not been sent yet.`,
          "The sweep that sends may have stopped or keep failing on this send, or another send may be taking every minute's sending allowance. Check the send's page and the app's logs. It picks up where it stopped, mailing no one twice.",
        ],
        link,
      );
    case "wedged":
      return message(
        `Problem with ${title}: waiting for you to resolve it`,
        [
          `${title} has handed off everyone it can, but the provider never answered for ${n.c_in_flight} recipients, so whether they were mailed is unknown. Sending them again could mail them twice, so the send waits for you.`,
          "Open the send and choose Resolve. Kestrel can't tell whether these emails went out, so unless you know, Assume not sent is the safe default: those readers may miss this post but get the next one, and no one is mailed twice. Choose Assume sent when you know otherwise, such as a reader who says they got it.",
        ],
        link,
      );
    case "missed": {
      const late =
        n.send_status === "scheduled"
          ? `${title} was due at ${when(n.fire_at)} and has not gone out.`
          : `${title} was due at ${when(n.fire_at)} and went out ${minutes((n.started_at ?? n.fire_at) - n.fire_at)} minutes late.`;
      return message(
        `Problem with ${title}: it missed its fire time`,
        [
          late,
          "A send only goes out late when the minute-by-minute sweep that fires it was not running or failed on it, so check the Worker's cron trigger and logs.",
        ],
        link,
      );
    }
  }
}

/**
 * Tell the publisher Claude imported a list for them (SPEC §8): the counts that changed who
 * gets their posts, and that Claude gave the attestation in their name. Written from the
 * import's record, which holds no address.
 */
export function composeImportNotification(n: DueImportNotification, config: Config): RenderedEmail {
  const c = (k: keyof OutcomeCounts): number => n.counts[k];
  const confirmed = c("added_confirmed") + c("confirmed_pending");
  const unsubscribed = c("unsubscribed") + c("erased") + c("added_unsubscribed");
  const notImported =
    c("kept_suppressed") +
    c("kept_unsubscribed") +
    c("kept_confirmed_newer") +
    c("left_out") +
    c("invalid");
  return message(
    `Claude imported ${confirmed} subscribers from ${n.file_name}`,
    [
      `Claude imported "${n.file_name}" into your list at ${when(n.created_at)}, through the API with its service token.`,
      `Confirmed as subscribers: ${confirmed}. Unsubscribed: ${unsubscribed}. Suppressions added: ${n.suppressions_added}. Not imported as subscribers (suppressed here, unsubscribed here, invalid, or with no consent claim): ${notImported}. Already on your list as the file says: ${c("unchanged")}.`,
      n.attestation_version === null
        ? "No one was confirmed, so no attestation was needed."
        : "Claude attested for you that everyone imported as subscribed opted in to receive your newsletter, and that the list isn’t purchased, rented, or scraped. If that isn’t so, remove those subscribers before your next post goes out.",
      "Nobody was emailed by the import.",
    ],
    dashboardLink(config.appOrigin, "/subscribers"),
  );
}

/** A sample, for the settings surface's test, so the channel can be proved before a send runs into a problem. */
export function sampleNotification(config: Config): RenderedEmail {
  return message(
    "Test: notifications from Kestrel",
    [
      "This is a test of the notifications that tell you when a send goes out, and right away if a send runs into a problem.",
      "If it arrived, the channel works; nothing else was sent.",
    ],
    dashboardLink(config.appOrigin, "/settings"),
  );
}

/**
 * Tell the publisher the SES sandbox refused a signup's confirmation (SPEC §7, §8): the reader
 * was told a link is on its way and none went, and every signup from an address not verified
 * in SES meets the same until AWS grants production access. Sent at most once a UTC day, and
 * naming no reader.
 */
export function composeSandboxNotification(config: Config): RenderedEmail {
  return message(
    "A signup's confirmation was refused: SES is still in the sandbox",
    [
      "Someone signed up, and Amazon SES refused to send their confirmation email, because the SES account is still in the sandbox, which mails only addresses verified in SES. They were told a link is on its way, so they may try again.",
      refusalAdvice("sandbox"),
      "Until then, every signup from an address not verified in SES is refused the same way, and a post reaches only verified addresses. You are told at most once a day.",
    ],
    dashboardLink(config.appOrigin, "/subscribers"),
  );
}
